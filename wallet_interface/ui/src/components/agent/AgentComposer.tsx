import { FormEvent, KeyboardEvent, useId, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "../ui";

export function AgentComposer({
  disabled = false,
  label = "Message Abby assistant",
  placeholder = "Ask about this screen, routes, or public 211 services",
  onSend
}: {
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  onSend: (message: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const composerId = useId();

  function submitMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const message = draft.trim();
    if (!message || disabled) return;
    setDraft("");
    onSend(message);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
  }

  return (
    <form className="agent-composer" onSubmit={submitMessage}>
      <label className="sr-only" htmlFor={composerId}>
        {label}
      </label>
      <textarea
        disabled={disabled}
        id={composerId}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={3}
        value={draft}
      />
      <Button ariaLabel="Send assistant message" disabled={!draft.trim() || disabled} type="submit">
        <Send aria-hidden="true" size={18} />
      </Button>
    </form>
  );
}
