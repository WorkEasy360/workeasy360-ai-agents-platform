/*
 * WorkEasy360 Agents website widget.
 * Usage: <script src="https://YOUR-APP/widget.js" data-agent="pk_..." async></script>
 * Adds a chat bubble that opens the agent in an iframe served from our origin.
 */
(function () {
  var script = document.currentScript;
  if (!script || window.__we360Widget) return;
  window.__we360Widget = true;

  var publicKey = script.getAttribute("data-agent");
  if (!publicKey) return console.warn("[WorkEasy360] data-agent attribute is missing");
  var origin = new URL(script.src).origin;

  fetch(origin + "/api/public/v1/deployments/" + encodeURIComponent(publicKey))
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (cfg) {
      if (!cfg || cfg.channel !== "web_widget") return;
      mount(cfg);
    })
    .catch(function () {});

  function mount(cfg) {
    var color = (cfg.theme && cfg.theme.primaryColor) || "#2a56e0";
    var side = cfg.theme && cfg.theme.position === "left" ? "left" : "right";
    var open = false;

    var root = document.createElement("div");
    root.style.cssText = "position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;font-family:system-ui,sans-serif";

    var frame = document.createElement("iframe");
    frame.src = origin + "/embed/" + encodeURIComponent(publicKey);
    frame.title = cfg.title || "Chat";
    frame.allow = "clipboard-write";
    frame.style.cssText =
      "display:none;width:380px;height:600px;max-height:calc(100vh - 110px);max-width:calc(100vw - 40px);" +
      "border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.18);margin-bottom:12px;background:#fff";

    var button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "Open chat");
    button.style.cssText =
      "display:block;margin-" + (side === "left" ? "right" : "left") + ":auto;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;" +
      "background:" + color + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.2)";
    var chatIcon =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var closeIcon =
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    button.innerHTML = chatIcon;

    function setOpen(next) {
      open = next;
      frame.style.display = open ? "block" : "none";
      button.innerHTML = open ? closeIcon : chatIcon;
      button.setAttribute("aria-label", open ? "Close chat" : "Open chat");
      // Full screen on small phones.
      if (open && window.innerWidth < 480) {
        frame.style.width = "calc(100vw - 40px)";
        frame.style.height = "calc(100vh - 110px)";
      }
    }
    button.addEventListener("click", function () {
      setOpen(!open);
    });

    root.appendChild(frame);
    root.appendChild(button);
    document.body.appendChild(root);
  }
})();
