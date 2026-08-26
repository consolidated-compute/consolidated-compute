export interface CompactSheetSafeAreaPaddingInput {
  isCompact: boolean;
  isKeyboardVisible: boolean;
  hasFooter: boolean;
  baseContentPadding: number;
  baseFooterPadding: number;
  safeAreaBottom: number;
}

export interface CompactSheetSafeAreaPadding {
  contentPaddingBottom?: number;
  footerPaddingBottom?: number;
}

export interface AdaptiveModalDismissalBehavior {
  acceptsDismissRequest: boolean;
  backdropPressBehavior: "close" | "none";
  enablePanDownToClose: boolean;
  showCloseButton: boolean;
}

export function getAdaptiveModalDismissalBehavior(
  dismissible: boolean,
): AdaptiveModalDismissalBehavior {
  return {
    acceptsDismissRequest: dismissible,
    backdropPressBehavior: dismissible ? "close" : "none",
    enablePanDownToClose: dismissible,
    showCloseButton: dismissible,
  };
}

interface BottomSheetVisibleContentHeightInput {
  containerHeight: number;
  contentPosition: number;
  handleHeight: number;
  keyboardHeight: number;
  isKeyboardVisible: boolean;
}

export function getBottomSheetVisibleContentHeight({
  containerHeight,
  contentPosition,
  handleHeight,
  keyboardHeight,
  isKeyboardVisible,
}: BottomSheetVisibleContentHeightInput): number {
  "worklet";
  return Math.max(
    0,
    containerHeight - contentPosition - handleHeight - (isKeyboardVisible ? keyboardHeight : 0),
  );
}

export function getCompactSheetSafeAreaPadding({
  isCompact,
  isKeyboardVisible,
  hasFooter,
  baseContentPadding,
  baseFooterPadding,
  safeAreaBottom,
}: CompactSheetSafeAreaPaddingInput): CompactSheetSafeAreaPadding {
  if (!isCompact || isKeyboardVisible || safeAreaBottom <= 0) {
    return {};
  }

  if (hasFooter) {
    return { footerPaddingBottom: baseFooterPadding + safeAreaBottom };
  }

  return { contentPaddingBottom: baseContentPadding + safeAreaBottom };
}
