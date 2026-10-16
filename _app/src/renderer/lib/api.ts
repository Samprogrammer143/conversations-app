import type { ConversationsApi } from "../../shared/api";

declare global {
  interface Window {
    conversations: ConversationsApi;
  }
}

export const api: ConversationsApi = window.conversations;
