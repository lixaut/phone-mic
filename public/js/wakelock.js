/* ============================================================
 * js/wakelock.js — 屏幕常亮开关（Wake Lock API）
 * 职责：
 *   1. 用户可点击顶栏「常亮」徽章手动开/关
 *   2. INPUT/OUTPUT 任意开启时自动常亮，两者都关时自动关闭
 *   3. 系统强制释放（切后台）时开关回弹到关
 * 依赖：Wake Lock API（Chrome/Android、Safari 16.4+）；不支持则隐藏开关
 * 对外暴露：window.PhoneMic.setWakeLock(on)
 * ============================================================ */

(function () {
  'use strict';

  var wakeLock = null;   // 当前 WakeLockSentinel，null = 未生效
  var btn = null;        // 顶栏「常亮」徽章元素

  /**
   * 申请/释放屏幕常亮
   * @param {boolean} on true=申请常亮，false=释放
   */
  async function setWakeLock(on) {
    try {
      // 浏览器不支持：隐藏开关（静默降级，不影响其他功能）
      if (!('wakeLock' in navigator)) { btn.style.display = 'none'; return; }

      if (on) {
        wakeLock = await navigator.wakeLock.request('screen');
        // 系统强制释放（如切后台）时回弹 UI
        wakeLock.addEventListener('release', function () {
          wakeLock = null;
          btn.classList.remove('on');
        });
        btn.classList.add('on');
      } else {
        if (wakeLock) { wakeLock.release(); wakeLock = null; }
        btn.classList.remove('on');
      }
    } catch (e) {
      // 申请失败（用户手势限制等）：静默，开关保持可手动点击
      PhoneMic.log('wake lock failed: ' + e.message);
    }
  }

  /** 模块初始化：绑定按钮事件（默认关，由 INPUT/OUTPUT 联动控制） */
  function init() {
    btn = document.getElementById('awakeBtn');
    btn.onclick = function () { setWakeLock(!wakeLock); };
  }

  // 挂到全局命名空间（无构建工具，用 window 约定模块边界）
  window.PhoneMic = window.PhoneMic || {};
  window.PhoneMic.setWakeLock = setWakeLock;
  window.PhoneMic.initWakeLock = init;
})();
