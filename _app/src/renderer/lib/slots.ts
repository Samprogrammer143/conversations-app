// Places where another shell of the window (the phone app) puts its own pieces in. The
// desktop leaves them empty.
import type { ComponentType } from "react";

export interface ListHeaderProps {
  /** The list's scope title ("All Conversations", a project). */
  title: string;
  onNewChat(): void;
}

export const slots: {
  /** Above the list, instead of the desktop's toolbar. */
  listHeader?: ComponentType<ListHeaderProps>;
  /** In the message box's controls: which PC the message goes to. */
  composerTarget?: ComponentType;
} = {};
