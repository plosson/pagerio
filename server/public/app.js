// Copy buttons: <button data-copy="element-id">. The label reads "Copied" for 1.5 s.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  if (!source) return;
  await navigator.clipboard.writeText(source.textContent.trim());
  const label = button.querySelector("span:last-child") ?? button;
  const text = label.textContent;
  label.textContent = "Copied";
  setTimeout(() => {
    label.textContent = text;
  }, 1500);
});

// Links to #how open the "How to send a page" section.
function openHow() {
  if (location.hash !== "#how") return;
  const details = document.getElementById("how");
  if (details) details.open = true;
}
window.addEventListener("hashchange", openHow);

// <time data-local> shows the reader's time zone: "Today at 13:58", or the date for older pages.
function localTime(date) {
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `Today at ${time}`;
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

document.addEventListener("DOMContentLoaded", () => {
  openHow();
  for (const el of document.querySelectorAll("time[data-local]")) {
    el.textContent = localTime(new Date(el.dateTime));
  }
});
