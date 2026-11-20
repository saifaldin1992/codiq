import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// ق-223 — A STALE TAB HEALS ITSELF. Every deploy deletes the previous chunks
// (`emptyOutDir: true`), and the server now answers a missing chunk with a real
// 404 rather than the shell. Vite fires `vite:preloadError` for exactly that
// case — a dynamic import that failed because the deployment moved on — and its
// documented response is to reload. On an Iraqi mobile network a chunk fetch
// also fails for ordinary reasons (a dropped connection mid-navigation), and
// today every one of those ended at the same English stack-trace screen; the
// reload is the difference between losing three seconds and losing the order
// the merchant was on the phone about. Guarded per session so a chunk that is
// genuinely gone for good cannot loop the page.
window.addEventListener("vite:preloadError", (event) => {
  const key = "codiq:preload-reload";
  let reloaded = false;
  try { reloaded = sessionStorage.getItem(key) === "1"; } catch { /* storage may be unavailable; reload once regardless */ }
  if (reloaded) return;
  try { sessionStorage.setItem(key, "1"); } catch { /* ignore */ }
  event.preventDefault();
  window.location.reload();
});
try { sessionStorage.removeItem("codiq:preload-reload"); } catch { /* ignore */ }

createRoot(document.getElementById("root")!).render(<App />);

// Analytics, injected ONLY when configured. The old static tag in index.html
// shipped the literal «%VITE_ANALYTICS_ENDPOINT%» whenever the variable was
// unset — which was always — so EVERY page load, production included, fired a
// guaranteed 400 plus a strict-MIME refusal in the console. An unset variable
// now means no request at all; the till's console tripwire is what caught it.
const analyticsEndpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT as string | undefined;
const analyticsWebsiteId = import.meta.env.VITE_ANALYTICS_WEBSITE_ID as string | undefined;
if (analyticsEndpoint && analyticsWebsiteId) {
  const script = document.createElement("script");
  script.defer = true;
  script.src = `${analyticsEndpoint}/umami`;
  script.dataset.websiteId = analyticsWebsiteId;
  document.head.appendChild(script);
}

