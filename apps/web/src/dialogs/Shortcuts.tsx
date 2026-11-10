import { Button, Dialog } from "@purss/ui";
import { useOverlays } from "../state/overlays.tsx";
import { SEARCH_KEY } from "../shell/Sidebar.tsx";

const K = ({ children }: { children: string }) => <kbd>{children}</kbd>;

export function ShortcutsDialog() {
  const ov = useOverlays();
  return (
    <Dialog title="Keyboard shortcuts" size="sm" onClose={ov.close} footer={<Button variant="primary" onClick={ov.close}>Done</Button>}>
      <h3 className="kg">Move and open</h3>
      <dl className="keys">
        <dt><K>j</K> <K>k</K></dt><dd>Next and previous item</dd>
        <dt><K>o</K> <K>Enter</K></dt><dd>Open the item in the panel</dd>
      </dl>
      <h3 className="kg">Set a state</h3>
      <dl className="keys">
        <dt><K>r</K></dt><dd>To read</dd>
        <dt><K>e</K></dt><dd>Finished</dd>
        <dt><K>i</K></dt><dd>Ignore, or restore an ignored item</dd>
        <dt><K>x</K></dt><dd>Select or unselect while Select is on</dd>
      </dl>
      <h3 className="kg">Selected text in an article</h3>
      <dl className="keys">
        <dt><K>h</K></dt><dd>Highlight it</dd>
        <dt><K>c</K></dt><dd>Highlight it with a comment</dd>
        <dt><K>Enter</K></dt><dd>On a highlight: change its comment or remove it</dd>
      </dl>
      <h3 className="kg">Everywhere</h3>
      <dl className="keys">
        <dt><K>{SEARCH_KEY}</K> <K>/</K></dt><dd>Search and jump</dd>
        <dt><K>p</K></dt><dd>Go to the player while something is playing</dd>
        <dt><K>?</K></dt><dd>This list</dd>
        <dt><K>Esc</K></dt><dd>Close a popup, menu or the panel</dd>
      </dl>
      <h3 className="kg">Mouse</h3>
      <dl className="keys">
        <dt>Right-click</dt><dd>Actions for an item, source, collection or basket</dd>
        <dt><K>Shift</K> + right-click</dt><dd>The browser's own menu</dd>
      </dl>
      <p className="fine">Arrow keys are left alone so scrolling, menus and screen readers work as usual.</p>
    </Dialog>
  );
}
