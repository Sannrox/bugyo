import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useSettings } from "./lib/settingsStore";
import { useFleet } from "./lib/fleetStore";

/** Custom window titlebar (macOS overlay style). The native title is hidden;
 * the sidebar collapse toggle and the global search button live here, next to
 * the traffic lights. The bar itself is a drag region so the window can still
 * be moved. */
export default function Titlebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const toggle = useSettings((s) => s.toggleSidebar);
  const openSearch = useFleet((s) => s.openSearch);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <button
        type="button"
        className="titlebar__btn"
        onClick={() => toggle()}
        aria-label={collapsed ? "expand sidebar" : "collapse sidebar"}
        aria-pressed={collapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <PanelLeftOpen size={20} aria-hidden />
        ) : (
          <PanelLeftClose size={20} aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="titlebar__btn"
        onClick={() => openSearch()}
        aria-label="search"
        title="Search (⌘F)"
      >
        <Search size={18} aria-hidden />
      </button>
    </div>
  );
}
