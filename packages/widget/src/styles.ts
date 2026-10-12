/** Scoped to the widget's shadow root; host page CSS cannot reach in and this cannot leak out. */
export const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.root, button, textarea, a {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Sinhala", "Iskoola Pota",
    "Noto Sans Tamil", "Latha", sans-serif;
  font-size: 15px; line-height: 1.45; color: #1f2328;
}
button { cursor: pointer; border-radius: 8px; border: 1px solid #d0d7de; background: #fff; padding: 6px 10px; }
button:disabled { cursor: not-allowed; opacity: .45; }
button:focus-visible, a:focus-visible, textarea:focus-visible { outline: 3px solid #0969da; outline-offset: 2px; }
.launcher { position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px; border-radius: 50%;
  border: none; background: #1f2328; color: #fff; font-size: 24px; box-shadow: 0 4px 16px rgba(0,0,0,.25); z-index: 2147483000; }
.panel { position: fixed; right: 20px; bottom: 20px; width: 380px; height: min(640px, calc(100vh - 40px));
  display: flex; flex-direction: column; background: #fff; border-radius: 16px; overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,.25); z-index: 2147483000; }
header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
  background: #1f2328; color: #fff; font-weight: 600; }
.close { background: transparent; border: none; color: #fff; font-size: 22px; padding: 0 6px; }
.messages { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.message p { margin: 0; white-space: pre-wrap; word-break: break-word; }
.message.user { align-self: flex-end; background: #ddf4ff; border-radius: 12px 12px 2px 12px; padding: 8px 12px; max-width: 85%; }
.message.assistant { align-self: stretch; }
.status { color: #57606a; font-style: italic; margin: 0; }
.error { color: #cf222e; margin: 0; }
.products { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-direction: column; gap: 8px; }
.product { display: flex; gap: 10px; border: 1px solid #d0d7de; border-radius: 12px; padding: 8px; }
.product img { width: 72px; height: 90px; object-fit: cover; border-radius: 8px; flex-shrink: 0; }
.product-body, .card { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.card { border: 1px solid #d0d7de; border-radius: 12px; padding: 10px; margin-top: 8px; }
.ref { font-size: 12px; color: #57606a; }
.title { font-weight: 600; color: inherit; text-decoration: none; }
a.title:hover { text-decoration: underline; }
.price { font-weight: 600; }
.badge { font-size: 12px; align-self: flex-start; border-radius: 999px; padding: 1px 8px; background: #dafbe1; color: #116329; }
.badge.low_stock, .badge.backorder { background: #fff8c5; color: #7d4e00; }
.badge.out_of_stock { background: #ffebe9; color: #a40e26; }
.variants { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 0; padding: 0; border: 0; min-width: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.chip { padding: 4px 10px; border-radius: 999px; }
.cart ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.line { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.qty { display: inline-flex; align-items: center; gap: 6px; }
.qty button { padding: 0 8px; }
.subtotal { display: flex; justify-content: space-between; font-weight: 600; border-top: 1px solid #d0d7de; padding-top: 6px; }
.primary { background: #1f2328; color: #fff; border: none; padding: 8px 14px; text-align: center; text-decoration: none; display: inline-block; border-radius: 8px; }
.notice { background: #f6f8fa; }
.composer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #d0d7de; }
.composer textarea { flex: 1; resize: none; border: 1px solid #d0d7de; border-radius: 8px; padding: 8px; }
.consent { padding: 12px 16px; border-top: 1px solid #d0d7de; display: flex; flex-direction: column; gap: 8px; }
.consent p { margin: 0; color: #57606a; font-size: 14px; }
.cod-form fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.cod-form legend { font-weight: 600; margin-bottom: 4px; }
.field { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.field input, .field select { font: inherit; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 8px; }
.cod-summary address { font-style: normal; color: #57606a; font-size: 13px; }
.subtotal.total { font-weight: 600; }
@media (max-width: 480px) {
  .panel { right: 0; bottom: 0; width: 100vw; height: 100dvh; border-radius: 0; }
}
`;
