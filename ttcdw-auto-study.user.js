// ==UserScript==
// @name         学习公社自动刷课
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  自动刷视频课程：静音播放、自动切换下一集、自动切换下一个未学习课程
// @author       wesuiliye & Claude Code
// @match        *://www.ttcdw.cn/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    var STORAGE_KEY = 'ttcdw_auto_study';

    function log(msg) { console.log('[自动刷课] ' + msg); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function getState() {
        try { var r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : {}; }
        catch (e) { return {}; }
    }
    function setState(obj) { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign({}, getState(), obj))); }
    function clearState() { localStorage.removeItem(STORAGE_KEY); }

    function formatTime(s) {
        if (!s || isNaN(s)) return '00:00';
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
        if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
        return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }

    var isClassroom = location.href.indexOf('/p/uc/myClassroom/') >= 0;
    var isVideo = location.href.indexOf('/p/course/videorevision/') >= 0;

    if (!isClassroom && !isVideo) return;

    // ======================== 课堂页面 ========================
    if (isClassroom) {
        var running = false;

        function addLog(m) {
            var el = document.getElementById('tt-log');
            if (el) el.innerHTML = '<div>[' + new Date().toLocaleTimeString() + '] ' + m + '</div>' + el.innerHTML;
        }
        function setStatus(t) { var e = document.getElementById('tt-status'); if (e) e.textContent = t; }

        function createPanel() {
            GM_addStyle(`
                #tt-panel{position:fixed;top:100px;right:20px;width:300px;background:#fff;border:2px solid #409EFF;
                border-radius:8px;padding:12px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.15);
                font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px}
                #tt-panel .tt-title{font-size:15px;font-weight:bold;color:#303133;text-align:center;
                padding:4px 0 8px;border-bottom:1px solid #ebeef5;margin-bottom:8px;cursor:move}
                #tt-panel .tt-status{text-align:center;color:#606266;padding:6px 0}
                #tt-panel .tt-btns{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;padding:4px 0}
                #tt-panel .tt-btn{padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:12px;color:#fff}
                #tt-panel .tt-btn:hover{opacity:.85}
                #tt-panel .tt-log{max-height:200px;overflow-y:auto;margin-top:8px;padding:6px;background:#f5f7fa;
                border-radius:4px;font-size:11px;color:#606266;line-height:1.6}
            `);

            var panel = document.createElement('div');
            panel.id = 'tt-panel';
            panel.innerHTML =
                '<div class="tt-title" id="tt-drag">自动刷课控制台 v1.4</div>' +
                '<div class="tt-status" id="tt-status">就绪</div>' +
                '<div class="tt-btns">' +
                '<button class="tt-btn" id="tt-start" style="background:#67C23A">开始刷课</button>' +
                '<button class="tt-btn" id="tt-stop" style="background:#F56C6C;display:none">停止</button>' +
                '<button class="tt-btn" id="tt-filter" style="background:#409EFF">筛选未学习</button>' +
                '</div>' +
                '<div class="tt-log" id="tt-log"></div>';
            document.body.appendChild(panel);

            // 拖动
            (function () {
                var drag = false, dx, dy, h = document.getElementById('tt-drag');
                h.onmousedown = function (e) { drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; };
                document.onmousemove = function (e) { if (!drag) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; };
                document.onmouseup = function () { drag = false; };
            })();

            document.getElementById('tt-start').onclick = startAuto;
            document.getElementById('tt-stop').onclick = stopAuto;
            document.getElementById('tt-filter').onclick = filterUnlearned;
        }

        function showStartBtn() {
            document.getElementById('tt-start').style.display = '';
            document.getElementById('tt-stop').style.display = 'none';
        }
        function showStopBtn() {
            document.getElementById('tt-start').style.display = 'none';
            document.getElementById('tt-stop').style.display = '';
        }

        function filterUnlearned() {
            var spans = document.querySelectorAll('span.total');
            for (var i = 0; i < spans.length; i++) {
                if (spans[i].textContent.trim() === '未学习') { spans[i].click(); addLog('已筛选"未学习"'); return; }
            }
        }

        function getCourseName(row) {
            var cells = row.querySelectorAll('.cell');
            for (var j = 0; j < cells.length; j++) {
                var t = cells[j].textContent.trim();
                if (t.length > 5 && t.indexOf(':') < 0 && t.indexOf('%') < 0 && t !== '学习') return t.substring(0, 50);
            }
            return '未知';
        }

        // 等待Vue路由更新DOM后，确认有新的课程行出现
        async function waitForPageChange(oldFirstId, maxWait) {
            var start = Date.now();
            while (Date.now() - start < (maxWait || 8000)) {
                await sleep(500);
                var firstRow = document.querySelector('.el-table__row');
                if (firstRow) {
                    var firstText = getCourseName(firstRow);
                    if (firstText !== oldFirstId) return true;
                }
            }
            return false;
        }

        // 点击“专业课选学”按钮
        async function clickProfessionalCourse(courseName) {
            addLog('正在查找“' + courseName + '”按钮...');
            var timeout = 1500;
            var start = Date.now();

            while (Date.now() - start < timeout) {
                if (!running) return false;

                var items = document.querySelectorAll('.item-one');

                for (var i = 0; i < items.length; i++) {
                    var item = items[i];
                    var title = item.querySelector('.item-title');

                    if (title && title.textContent.trim() === '专业课选学') {
                        addLog('找到“' + courseName + '”按钮');

                        // 如果已经是当前选中的栏目，则不重复点击
                        if (item.classList.contains('assess-active')) {
                            addLog('已选择“' + courseName + '”，无需重复点击');
                            return true;
                        }
                        item.scrollIntoView({
                            behavior: 'smooth',
                            block: 'center'
                        });
                        await sleep(300);
                        item.click();
                        addLog('已点击“' + courseName + '”');
                        // 等待 Vue 完成页面切换
                        await sleep(1500);
                        return true;
                    }
                }
                await sleep(300);
            }
            addLog('未找到' + courseName + '按钮');
            return false;
        }

        async function processPage() {
            if (!running) return;
            //切换课程到“专业课选学”，如果不需要切换，注释下面这行，如果需要切换其他课，请修改下面函数参数为需要切换课程的button名。
            clickProfessionalCourse('专业课选学');

            // 重新应用"未学习"筛选（Vue路由翻页后可能丢失）
            filterUnlearned();
            await sleep(1500);

            var rows = document.querySelectorAll('.el-table__row');
            var found = false;

            for (var i = 0; i < rows.length; i++) {
                if (!running) return;
                var prog = rows[i].querySelector('.el-progress__text');
                var progressText = prog ? prog.textContent.trim() : '';
                if (progressText === '100%') continue;

                found = true;
                var name = getCourseName(rows[i]);
                setStatus('正在: ' + name);
                addLog('打开: ' + name);

                setState({ running: true, action: 'openVideo', courseName: name, returnUrl: location.href });

                // 拦截 window.open 获取视频 URL，避免浏览器弹窗拦截
                var capturedUrl = null;
                var origOpen = window.open;
                window.open = function (url) { capturedUrl = url; return null; };
                var btn = rows[i].querySelector('.study-btn');
                if (btn) btn.click();
                window.open = origOpen;

                if (capturedUrl) {
                    addLog('视频已打开，等待播放完成...');
                    location.href = capturedUrl;
                } else {
                    addLog('未能获取视频地址，跳过');
                }
                return;
            }

            if (!found) {
                // 当前页无未完成课程，翻到下一页
                var next = document.querySelector('.btn-next:not([disabled])');
                if (next) {
                    var oldFirst = getCourseName(document.querySelector('.el-table__row'));
                    addLog('当前页完成，翻下一页');
                    setStatus('翻页中...');
                    next.click();

                    // 等待Vue路由更新DOM
                    var changed = await waitForPageChange(oldFirst, 10000);
                    if (changed && running) {
                        addLog('新页面已加载');
                        await processPage(); // 递归处理新页面
                    } else if (!changed) {
                        addLog('翻页超时或无更多课程');
                        setStatus('翻页异常，请手动检查');
                        stopAuto();
                    }
                } else {
                    setStatus('全部完成！');
                    addLog('所有课程学习完毕！');
                    stopAuto();
                }
            }
        }

        async function startAuto() {
            running = true;
            showStopBtn();
            setState({ running: true, action: 'processPage' });
            addLog('开始自动刷课...');
            setStatus('筛选中...');
            filterUnlearned();
            await sleep(2000);
            await processPage();
        }

        function stopAuto() {
            running = false;
            clearState();
            showStartBtn();
            setStatus('已停止');
            addLog('已停止');
        }

        // 页面刷新后自动恢复（视频页完成后导航回来触发）
        async function autoResume() {
            var st = getState();
            if (!st.running) return;

            log('autoResume: action=' + st.action);
            running = true;
            showStopBtn();

            switch (st.action) {
                case 'openVideo':
                    // 视频播完，导航回来了
                    addLog('视频完成，继续下一课');
                    setStatus('继续下一课...');
                    await sleep(2000);
                    await processPage();
                    break;
                case 'nextPage':
                    addLog('继续处理新页面');
                    await sleep(2000);
                    await processPage();
                    break;
                default:
                    addLog('恢复运行');
                    await sleep(1000);
                    await processPage();
                    break;
            }
        }

        createPanel();
        autoResume();
    }

    // ======================== 视频页面 ========================
    if (isVideo) {
        var infoPanel = document.createElement('div');
        infoPanel.style.cssText = 'position:fixed;top:10px;right:10px;background:rgba(0,0,0,.8);color:#fff;padding:10px 16px;border-radius:6px;z-index:99999;font-size:13px;min-width:240px;font-family:sans-serif;';
        infoPanel.innerHTML = '<div style="font-weight:bold;margin-bottom:6px;color:#67C23A">自动刷课运行中</div><div id="tt-vprog">初始化...</div>';
        document.body.appendChild(infoPanel);

        function setVStatus(t) { var e = document.getElementById('tt-vprog'); if (e) e.textContent = t; }

        var monitorTimer = null;
        var switchingVideo = false;

        function playNext() {
            if (switchingVideo) return;
            switchingVideo = true;

            var items = document.querySelectorAll('.videorevision-catalogue-single');
            var foundCur = false, next = null;

            for (var i = 0; i < items.length; i++) {
                var active = items[i].className.indexOf('on') >= 0;
                var p = items[i].querySelector('.videorevision-catalogue-single-progress');
                var pct = p ? p.textContent.trim() : '';
                if (active) { foundCur = true; continue; }
                if (foundCur && pct !== '100%') { next = items[i]; break; }
            }
            if (!next) {
                for (var j = 0; j < items.length; j++) {
                    var pp = items[j].querySelector('.videorevision-catalogue-single-progress');
                    if (pp && pp.textContent.trim() !== '100%') { next = items[j]; break; }
                }
            }

            if (next) {
                var nameEl = next.querySelector('.videorevision-catalogue-single-name');
                log('切换: ' + (nameEl ? nameEl.textContent.trim() : '下一集'));
                setVStatus('切换: ' + (nameEl ? nameEl.textContent.trim() : '下一集'));
                next.click();
                waitForNewVideoAndMonitor();
            } else {
                log('课程全部完成，返回课堂');
                setVStatus('完成，返回课堂...');
                var st = getState();
                if (st.returnUrl) {
                    setState({ running: true, action: 'openVideo' });
                    setTimeout(function () { location.href = st.returnUrl; }, 2000);
                }
            }
        }

        function waitForNewVideoAndMonitor() {
            if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
            var waitCount = 0, lastSrc = '';
            var timer = setInterval(function () {
                waitCount++;
                var video = document.querySelector('video');
                if (video && video.duration > 0 && video.currentSrc !== lastSrc) {
                    clearInterval(timer);
                    lastSrc = video.currentSrc;
                    switchingVideo = false;
                    log('新视频已加载');
                    startMonitor(video);
                }
                if (waitCount > 60) { clearInterval(timer); switchingVideo = false; setVStatus('等待超时'); }
            }, 1000);
        }

        function startMonitor(video) {
            if (monitorTimer) clearInterval(monitorTimer);

            video.muted = true;
            video.volume = 0;
            video.play().catch(function () {
                var btn = document.querySelector('.vjs-big-play-button, [class*="play-btn"]');
                if (btn) btn.click();
                setTimeout(function () { video.play().catch(function () {}); }, 500);
            });

            document.addEventListener('visibilitychange', function (e) {
                e.stopImmediatePropagation();
                if (document.hidden && video && video.paused && !video.ended) {
                    video.muted = true;
                    video.play().catch(function () {});
                }
            }, true);

            var stuckCount = 0, lastTime = -1;

            monitorTimer = setInterval(function () {
                if (!video || !document.contains(video)) { clearInterval(monitorTimer); monitorTimer = null; return; }

                if (video.paused && !video.ended) { video.muted = true; video.play().catch(function () {}); }
                if (!video.muted) { video.muted = true; video.volume = 0; }

                if (!video.paused && !video.ended && Math.abs(video.currentTime - lastTime) < 0.5) {
                    stuckCount++;
                    if (stuckCount > 6) {
                        video.currentTime = video.currentTime;
                        video.play().catch(function () {});
                        stuckCount = 0;
                    }
                } else { stuckCount = 0; }
                lastTime = video.currentTime;

                var progress = video.duration > 0 ? Math.round(video.currentTime / video.duration * 100) : 0;
                setVStatus('播放中: ' + progress + '% (' + formatTime(video.currentTime) + '/' + formatTime(video.duration) + ') 静音');

                if (video.ended || progress >= 99) {
                    clearInterval(monitorTimer);
                    monitorTimer = null;
                    log('视频播完');
                    setVStatus('播完，切换...');
                    setTimeout(playNext, 2000);
                }
            }, 3000);

            video.addEventListener('ended', function () {
                if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
                log('ended事件');
                setVStatus('结束，切换...');
                setTimeout(playNext, 2000);
            });
        }

        (async function () {
            log('视频页面启动');
            setVStatus('等待视频...');
            var video = null;
            for (var i = 0; i < 30; i++) {
                video = document.querySelector('video');
                if (video && video.duration > 0) break;
                await sleep(1000);
            }
            if (video && video.duration > 0) {
                log('视频就绪');
                startMonitor(video);
            } else {
                setVStatus('未找到视频');
            }
        })();
    }
})();
