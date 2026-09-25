import { LuPlus } from "react-icons/lu";

/**
 * The "New Chat" button for small displays: opens a fresh session in the
 * current workspace, titled from the time it was created (e.g. "Sep 19, 2:05
 * PM"). The naming is done by the handler it calls (App), which owns session
 * creation and navigation; this stays a dumb, big, thumb-sized control.
 */
export function NewChatButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Start a new chat (named from the time)"
      aria-label="Start a new chat"
      className="compact-newchat"
    >
      <LuPlus />
      <span>New Chat</span>
    </button>
  );
}
