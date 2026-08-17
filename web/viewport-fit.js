(() => {
  const root = document.documentElement;
  root.style.scrollbarGutter = "stable";
  let resizeFrame = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;

  function readViewport() {
    return {
      width: window.visualViewport?.width || window.innerWidth,
      height: window.visualViewport?.height || window.innerHeight
    };
  }

  function fitViewport(force = false, immediate = false) {
    const viewport = readViewport();

    if (!force && viewportWidth === viewport.width && viewportHeight === viewport.height) {
      return;
    }

    viewportWidth = viewport.width;
    viewportHeight = viewport.height;
    cancelAnimationFrame(resizeFrame);

    const applyFit = () => {
      root.style.zoom = "1";
      const measuredViewport = readViewport();
      const contentWidth = Math.max(root.scrollWidth, document.body?.scrollWidth || 0);
      const contentHeight = Math.max(root.scrollHeight, document.body?.scrollHeight || 0);
      const widthScale = contentWidth ? measuredViewport.width / contentWidth : 1;
      const heightScale = root.dataset.viewportFit === "width"
        ? 1
        : contentHeight ? measuredViewport.height / contentHeight : 1;
      const scale = Math.max(0.45, Math.min(1, widthScale, heightScale));

      // Keep measurement and the final zoom in one frame so zoom: 1 is never painted.
      root.style.zoom = scale > 0.985 ? "1" : scale.toFixed(4);
      root.dataset.viewportScale = scale.toFixed(4);
      viewportWidth = measuredViewport.width;
      viewportHeight = measuredViewport.height;
    };

    if (immediate) applyFit();
    else resizeFrame = requestAnimationFrame(applyFit);
  }

  window.CandyMoViewportFit = () => fitViewport(true);
  addEventListener("resize", () => fitViewport(), { passive: true });
  addEventListener("orientationchange", () => fitViewport(true), { passive: true });
  addEventListener("pageshow", () => fitViewport(true), { passive: true });
  window.visualViewport?.addEventListener("resize", () => fitViewport(), { passive: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => fitViewport(true, true), { once: true });
  } else {
    fitViewport(true, true);
  }

  document.fonts?.ready.then(() => fitViewport(true)).catch(() => {});
})();
