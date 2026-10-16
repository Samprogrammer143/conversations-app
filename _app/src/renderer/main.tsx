import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/detail.css";
import "./styles/overlays.css";
import "./styles/windows.css";
import { App } from "./App";
import { SettingsApp } from "./features/SettingsApp";
import { FlyoutApp } from "./features/FlyoutApp";
import { WelcomeApp } from "./features/Overlays";
import { api } from "./lib/api";
import { installOverlayScrollbars } from "./lib/scrollbars";

const kind = api.app.windowKind();
const Root = kind === "settings" ? SettingsApp : kind === "flyout" ? FlyoutApp : kind === "welcome" ? WelcomeApp : App;
document.body.dataset.window = kind;
installOverlayScrollbars();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
