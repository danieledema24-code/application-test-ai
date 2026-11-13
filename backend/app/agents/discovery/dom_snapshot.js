// Sanitised DOM snapshot: values of password and hidden inputs are removed before capture.
(() => {
  const root = document.documentElement.cloneNode(true);
  root.querySelectorAll("input[type=password], input[type=hidden]").forEach((n) => n.removeAttribute("value"));
  return "<!doctype html>\n" + root.outerHTML;
})()
