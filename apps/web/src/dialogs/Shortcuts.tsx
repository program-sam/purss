import { app } from "@purss/copy/app";
import { Button, Dialog } from "@purss/ui";
import { useOverlays } from "../state/overlays.tsx";
import { SEARCH_KEY } from "../shell/Sidebar.tsx";

const t = app.dialogs.shortcuts;

const K = ({ children }: { children: string }) => <kbd>{children}</kbd>;

export function ShortcutsDialog() {
  const ov = useOverlays();
  return (
    <Dialog title={t.title} size="sm" onClose={ov.close} footer={<Button variant="primary" onClick={ov.close}>{t.done}</Button>}>
      <h3 className="kg">{t.moveAndOpen.heading}</h3>
      <dl className="keys">
        <dt><K>j</K> <K>k</K></dt><dd>{t.moveAndOpen.next}</dd>
        <dt><K>o</K> <K>{t.keys.enter}</K></dt><dd>{t.moveAndOpen.open}</dd>
      </dl>
      <h3 className="kg">{t.setState.heading}</h3>
      <dl className="keys">
        <dt><K>r</K></dt><dd>{t.setState.toRead}</dd>
        <dt><K>e</K></dt><dd>{t.setState.finished}</dd>
        <dt><K>i</K></dt><dd>{t.setState.ignore}</dd>
        <dt><K>x</K></dt><dd>{t.setState.select}</dd>
      </dl>
      <h3 className="kg">{t.selectedText.heading}</h3>
      <dl className="keys">
        <dt><K>h</K></dt><dd>{t.selectedText.highlight}</dd>
        <dt><K>c</K></dt><dd>{t.selectedText.highlightComment}</dd>
        <dt><K>{t.keys.enter}</K></dt><dd>{t.selectedText.onHighlight}</dd>
      </dl>
      <h3 className="kg">{t.everywhere.heading}</h3>
      <dl className="keys">
        <dt><K>{SEARCH_KEY}</K> <K>/</K></dt><dd>{t.everywhere.search}</dd>
        <dt><K>p</K></dt><dd>{t.everywhere.player}</dd>
        <dt><K>?</K></dt><dd>{t.everywhere.list}</dd>
        <dt><K>{t.keys.esc}</K></dt><dd>{t.everywhere.close}</dd>
      </dl>
      <h3 className="kg">{t.mouse.heading}</h3>
      <dl className="keys">
        <dt>{t.keys.rightClick}</dt><dd>{t.mouse.actions}</dd>
        <dt><K>{t.keys.shift}</K>{t.mouse.shiftRightClick}</dt><dd>{t.mouse.browserMenu}</dd>
      </dl>
      <p className="fine">{t.arrowKeys}</p>
    </Dialog>
  );
}
