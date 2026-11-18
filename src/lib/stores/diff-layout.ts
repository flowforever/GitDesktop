import { create } from "zustand";

interface DiffLayoutState {
  fileRailWidth: number;
  oldPanePercent: number;
  mrChatWidth: number;
  mrChatCollapsed: boolean;
  setFileRailWidth: (width: number) => void;
  setOldPanePercent: (percent: number) => void;
  setMrChatWidth: (width: number) => void;
  setMrChatCollapsed: (collapsed: boolean) => void;
}

/** Session layout survives keyed file panes without growing native settings. */
export const useDiffLayoutStore = create<DiffLayoutState>()((set) => ({
  fileRailWidth: 288,
  oldPanePercent: 50,
  mrChatWidth: 384,
  mrChatCollapsed: false,
  setFileRailWidth: (fileRailWidth) => set({ fileRailWidth }),
  setOldPanePercent: (oldPanePercent) => set({ oldPanePercent }),
  setMrChatWidth: (mrChatWidth) => set({ mrChatWidth }),
  setMrChatCollapsed: (mrChatCollapsed) => set({ mrChatCollapsed }),
}));
