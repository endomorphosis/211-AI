import { Children, cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Info, LoaderCircle, X } from "lucide-react";

const requiredFieldControlTypes = new Set(["input", "select", "textarea"]);

type ElementWithChildren = {
  children?: ReactNode;
};

type ControlSemantics = {
  required?: boolean;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
};

function applyControlSemantics(children: ReactNode, semantics: ControlSemantics): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) {
      return child;
    }

    if (typeof child.type === "string" && requiredFieldControlTypes.has(child.type)) {
      const childProps = child.props as Record<string, unknown>;
      const currentDescribedBy =
        typeof childProps["aria-describedby"] === "string" ? childProps["aria-describedby"] : "";
      const describedBy = [currentDescribedBy, semantics.ariaDescribedBy].filter(Boolean).join(" ") || undefined;
      return cloneElement(child as ReactElement<Record<string, unknown>>, {
        ...(semantics.required ? { required: true, "aria-required": true } : {}),
        ...(semantics.ariaInvalid ? { "aria-invalid": true } : {}),
        ...(describedBy ? { "aria-describedby": describedBy } : {})
      });
    }

    const childProps = child.props as ElementWithChildren;

    if (!childProps.children) {
      return child;
    }

    return cloneElement(child as ReactElement<ElementWithChildren>, {
      children: applyControlSemantics(childProps.children, semantics)
    });
  });
}

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "danger" | "quiet";
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  className?: string;
  ariaLabel?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  ariaPressed?: boolean;
};

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled = false,
  loading = false,
  loadingLabel = "Loading",
  className = "",
  ariaLabel,
  ariaControls,
  ariaExpanded,
  ariaPressed
}: ButtonProps) {
  return (
    <button
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-busy={loading || undefined}
      className={`button button-${variant} ${className}`}
      data-loading={loading ? "true" : undefined}
      disabled={disabled || loading}
      onClick={onClick}
      type={type}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="loading-icon" size={18} /> : null}
      {loading ? loadingLabel : children}
    </button>
  );
}

export function RequiredMarker() {
  return (
    <>
      <strong aria-hidden="true" className="required-marker">
        *
      </strong>
      <span className="sr-only">required</span>
    </>
  );
}

export function Field({
  label,
  children,
  help,
  error,
  required = false
}: {
  label: string;
  children: ReactNode;
  help?: string;
  error?: string;
  required?: boolean;
}) {
  const fieldId = useId();
  const helpId = help ? `${fieldId}-help` : "";
  const errorId = error ? `${fieldId}-error` : "";
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  const fieldChildren =
    required || error || describedBy
      ? applyControlSemantics(children, {
          required,
          ariaDescribedBy: describedBy,
          ariaInvalid: Boolean(error)
        })
      : children;

  return (
    <label className={`field ${error ? "field-error" : ""}`}>
      <span className="field-title">
        {label}
        {required ? <RequiredMarker /> : null}
      </span>
      {fieldChildren}
      {help ? (
        <small className="field-help-text" id={helpId}>
          {help}
        </small>
      ) : null}
      {error ? (
        <small className="field-error-text" id={errorId} role="alert">
          {error}
        </small>
      ) : null}
    </label>
  );
}

export function Section({
  title,
  eyebrow,
  children,
  actions
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="section" aria-labelledby={title.replace(/\s+/g, "-")}>
      <div className="section-heading">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2 id={title.replace(/\s+/g, "-")}>{title}</h2>
        </div>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function StatusBanner({
  tone,
  children
}: {
  tone: "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" || tone === "danger" ? AlertTriangle : Info;
  return (
    <div className={`status-banner status-${tone}`} role="status">
      <Icon aria-hidden="true" size={20} />
      <span>{children}</span>
    </div>
  );
}

export function ActionCard({
  title,
  detail,
  icon,
  onClick
}: {
  title: string;
  detail: string;
  icon: ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="action-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ChevronRight aria-hidden="true" size={22} />
    </>
  );

  if (!onClick) {
    return <article className="action-card action-card-static">{content}</article>;
  }

  return (
    <button className="action-card" onClick={onClick} type="button">
      {content}
    </button>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({
  title,
  children,
  actions
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <article className="card" aria-labelledby={title.replace(/\s+/g, "-")}>
      <div className="card-heading">
        <h3 id={title.replace(/\s+/g, "-")}>{title}</h3>
        {actions ? <div className="card-actions">{actions}</div> : null}
      </div>
      {children}
    </article>
  );
}

export function Dialog({
  title,
  children,
  actions,
  onClose,
  open
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  open: boolean;
}) {
  if (!open) return null;

  return (
    <div className="dialog-backdrop">
      <div aria-labelledby={title.replace(/\s+/g, "-")} aria-modal="true" className="dialog" role="dialog">
        <div className="dialog-heading">
          <h2 id={title.replace(/\s+/g, "-")}>{title}</h2>
          <Button ariaLabel={`Close ${title}`} onClick={onClose} variant="quiet">
            <X aria-hidden="true" size={18} />
          </Button>
        </div>
        <div className="dialog-body">{children}</div>
        {actions ? <div className="dialog-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Stepper({
  label,
  steps,
  currentStep
}: {
  label: string;
  steps: string[];
  currentStep: number;
}) {
  return (
    <ol aria-label={label} className="stepper">
      {steps.map((step, index) => {
        const state = index < currentStep ? "complete" : index === currentStep ? "current" : "upcoming";
        return (
          <li aria-current={state === "current" ? "step" : undefined} className={`step step-${state}`} key={step}>
            <span className="step-marker">{index + 1}</span>
            <span>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function StatusIndicator({
  label,
  detail,
  tone = "neutral"
}: {
  label: string;
  detail?: string;
  tone?: Tone;
}) {
  return (
    <div className={`status-indicator status-indicator-${tone}`} role="status">
      <span aria-hidden="true" className="status-dot" />
      <span>
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </div>
  );
}

export function LoadingIndicator({ label = "Loading" }: { label?: string }) {
  return (
    <span aria-live="polite" className="loading-indicator" role="status">
      <LoaderCircle aria-hidden="true" className="loading-icon" size={18} />
      {label}
    </span>
  );
}

export function SensitiveValue({
  label,
  value,
  redactedValue = "Hidden",
  copyDisabledLabel = "Copy disabled"
}: {
  label: string;
  value: string;
  redactedValue?: string;
  copyDisabledLabel?: string;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="sensitive-value" data-copy-disabled="true" onCopy={(event) => event.preventDefault()}>
      <span className="sensitive-label">{label}</span>
      <code aria-label={`${label} ${revealed ? "revealed" : "redacted"}`} aria-live="polite">
        {revealed ? value : redactedValue}
      </code>
      <Badge tone="warning">{copyDisabledLabel}</Badge>
      <Button ariaLabel={`${revealed ? "Hide" : "Reveal"} ${label}`} onClick={() => setRevealed(!revealed)} variant="secondary">
        {revealed ? "Hide" : "Reveal"}
      </Button>
    </div>
  );
}
