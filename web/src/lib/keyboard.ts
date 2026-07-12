type KeyboardEventLike = {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

export function isComposingKeyEvent(event: KeyboardEventLike) {
  return Boolean(
    event.isComposing ||
      event.nativeEvent?.isComposing ||
      event.key === "Process" ||
      event.keyCode === 229 ||
      event.nativeEvent?.keyCode === 229
  );
}
