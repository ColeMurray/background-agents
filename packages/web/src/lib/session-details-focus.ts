export function focusSessionDetailsTrigger(
  isPhone: boolean,
  actionsButton: HTMLButtonElement | null,
  detailsButton: HTMLButtonElement | null
) {
  const preferred = isPhone ? actionsButton : detailsButton;
  const fallback = isPhone ? detailsButton : actionsButton;
  const isVisible = (button: HTMLButtonElement | null) =>
    button !== null && button.offsetParent !== null;

  const target = [preferred, fallback].find(isVisible);
  target?.focus();
}
