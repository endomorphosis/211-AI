import { Bot, MessageSquare, Mic, X } from "lucide-react";
import type {
  AgentConfirmationRequest,
  AgentMessage,
  AgentToolCall,
  AgentToolResult,
  EvidenceBundle
} from "../../agent/types";
import type { AgentMessageAudioRecord } from "../../agent/chatController";
import type { SupportedLocale } from "../../lib/localization";
import { Button } from "../ui";
import { AgentComposer } from "./AgentComposer";
import { AgentAudioChatSurface } from "./AgentAudioChatSurface";
import { AgentChatBottomSheet } from "./AgentChatBottomSheet";
import { AgentMessageList } from "./AgentMessageList";
import { AgentRuntimeStatus } from "./AgentRuntimeStatus";

export type AgentChatMode = "text" | "audio";

export function AgentChatDrawer({
  activeRouteLabel,
  confirmations = [],
  evidenceBundles = [],
  mode = "text",
  messages,
  open,
  responding = false,
  autoTranslateAssistant = false,
  composerLabel = "Message Abby assistant",
  composerPlaceholder = "Ask about this screen, routes, or public 211 services",
  assistantLabel = "Abby assistant",
  voiceLabel = "Abby voice",
  currentTaskLabel = "App-aware chat",
  currentTaskDetail = "Ask questions, move between screens, and review before wallet changes.",
  respondingLabel = "Abby is working through the request.",
  siteLocale = "en",
  translationLocale = "en",
  toolCalls = [],
  toolResults = [],
  onCancelConfirmation,
  onClose,
  onConfirmConfirmation,
  onOpenAudio,
  onOpenText,
  onAudioReply,
  onOpenServiceDetail,
  onSend
}: {
  activeRouteLabel: string;
  confirmations?: AgentConfirmationRequest[];
  evidenceBundles?: EvidenceBundle[];
  mode?: AgentChatMode;
  messages: AgentMessage[];
  open: boolean;
  responding?: boolean;
  autoTranslateAssistant?: boolean;
  composerLabel?: string;
  composerPlaceholder?: string;
  assistantLabel?: string;
  voiceLabel?: string;
  currentTaskLabel?: string;
  currentTaskDetail?: string;
  respondingLabel?: string;
  siteLocale?: SupportedLocale;
  translationLocale?: string;
  toolCalls?: AgentToolCall[];
  toolResults?: AgentToolResult[];
  onCancelConfirmation?: (confirmationId: string) => void;
  onClose: () => void;
  onConfirmConfirmation?: (confirmationId: string) => void;
  onOpenAudio: () => void;
  onOpenText: () => void;
  onOpenServiceDetail?: (docId: string) => void;
  onSend: (message: string) => void;
  onAudioReply?: (messageId: string, record: AgentMessageAudioRecord) => void;
}) {
  return (
    <>
      <AgentChatBottomSheet
        activeRouteLabel={activeRouteLabel}
        confirmations={confirmations}
        evidenceBundles={evidenceBundles}
        mode={mode}
        messages={messages}
        autoTranslateAssistant={autoTranslateAssistant}
        composerLabel={composerLabel}
        composerPlaceholder={composerPlaceholder}
        assistantLabel={assistantLabel}
        voiceLabel={voiceLabel}
        currentTaskLabel={currentTaskLabel}
        currentTaskDetail={currentTaskDetail}
        respondingLabel={respondingLabel}
        onCancelConfirmation={onCancelConfirmation}
        onClose={onClose}
        onConfirmConfirmation={onConfirmConfirmation}
        onOpenAudio={onOpenAudio}
        onOpenText={onOpenText}
        onOpenServiceDetail={onOpenServiceDetail}
        onSend={onSend}
        onAudioReply={onAudioReply}
        open={open}
        responding={responding}
        siteLocale={siteLocale}
        toolCalls={toolCalls}
        toolResults={toolResults}
        translationLocale={translationLocale}
      />
      <div className="agent-chat-shell">
        {!open ? (
          <div className="agent-chat-launcher" aria-label="Open Abby assistant">
            <Button
              ariaControls="agent-chat-drawer"
              ariaExpanded={open}
              ariaLabel="Open text chat"
              className="agent-chat-toggle agent-chat-toggle-text"
              onClick={onOpenText}
            >
              <MessageSquare aria-hidden="true" size={20} />
              <span>Text</span>
            </Button>
            <Button
              ariaControls="agent-chat-drawer"
              ariaExpanded={open}
              ariaLabel="Open voice chat"
              className="agent-chat-toggle agent-chat-toggle-audio"
              onClick={onOpenAudio}
            >
              <Mic aria-hidden="true" size={20} />
              <span>Audio</span>
            </Button>
          </div>
        ) : null}

        {open && mode === "text" ? (
          <aside aria-label="Abby text assistant" className="agent-chat-drawer" id="agent-chat-drawer">
            <header className="agent-chat-header">
              <div className="agent-chat-title">
                <span className="agent-chat-mark" aria-hidden="true">
                  <Bot size={20} />
                </span>
                <div>
                  <strong>{assistantLabel}</strong>
                  <small>{activeRouteLabel}</small>
                </div>
              </div>
              <Button ariaLabel="Close assistant" onClick={onClose} variant="quiet">
                <X aria-hidden="true" size={18} />
              </Button>
            </header>

            <div className="agent-current-task" role="status">
              <small>{currentTaskLabel}</small>
              <span>{currentTaskDetail}</span>
            </div>
            <AgentRuntimeStatus open={open} />

            <AgentMessageList
              autoTranslateAssistant={autoTranslateAssistant}
              confirmations={confirmations}
              evidenceBundles={evidenceBundles}
              messages={messages}
              onCancel={onCancelConfirmation}
              onConfirm={onConfirmConfirmation}
              onOpenServiceDetail={onOpenServiceDetail}
              responding={responding}
              siteLocale={siteLocale}
              toolCalls={toolCalls}
              toolResults={toolResults}
              translationLocale={translationLocale}
            />

            {responding ? (
              <div className="agent-typing" role="status">
                {respondingLabel}
              </div>
            ) : null}

            <AgentComposer disabled={responding} label={composerLabel} onSend={onSend} placeholder={composerPlaceholder} />
          </aside>
        ) : null}

        {open && mode === "audio" ? (
          <aside aria-label="Abby voice assistant" className="agent-chat-drawer agent-audio-chat-drawer" id="agent-chat-drawer">
            <header className="agent-chat-header">
              <div className="agent-chat-title">
                <span className="agent-chat-mark" aria-hidden="true">
                  <Mic size={20} />
                </span>
                <div>
                  <strong>{voiceLabel}</strong>
                  <small>{activeRouteLabel}</small>
                </div>
              </div>
              <Button ariaLabel="Close voice assistant" onClick={onClose} variant="quiet">
                <X aria-hidden="true" size={18} />
              </Button>
            </header>

            <AgentAudioChatSurface
              activeRouteLabel={activeRouteLabel}
              evidenceBundles={evidenceBundles}
              messages={messages}
              onClose={onClose}
              onSend={onSend}
              onAudioReply={onAudioReply}
              open={open && mode === "audio"}
              responding={responding}
              surface="drawer"
            />
            <AgentRuntimeStatus open={open} showModelSelector={false} />
          </aside>
        ) : null}
      </div>
    </>
  );
}
