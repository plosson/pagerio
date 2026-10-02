// Copy buttons: <button data-copy="element-id">
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  if (!source) return;
  await navigator.clipboard.writeText(source.textContent.trim());
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = label;
  }, 1500);
});

// Show times in the reader's time zone.
document.addEventListener("DOMContentLoaded", () => {
  for (const el of document.querySelectorAll("time[datetime]")) {
    el.textContent = new Date(el.dateTime).toLocaleString();
  }
});
