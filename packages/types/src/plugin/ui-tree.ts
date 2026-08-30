/**
 * Tier 0 declarative UI tree — plugin backends describe UI as data and
 * the host renders it with its own components (the plugin ships no UI code).
 */

/** Declarative component vocabulary. P2 minimal set. */
export type DeclarativeComponent =
  | 'Column'
  | 'Row'
  | 'Text'
  | 'Button'
  | 'Card'
  | 'Badge'
  | 'List'
  | 'Separator'
  | 'Spinner'
  | 'EmptyState'
  | 'Input'
  | 'Image'
  | 'KeyValue';

export interface UiNode {
  component: DeclarativeComponent;
  props?: Record<string, unknown>;
  children?: UiNode[];
  /** Event ids looped back to the backend, e.g. { onClick: "inc" }. */
  events?: { onClick?: string; onSubmit?: string };
}

/**
 * A declarative panel render message sent from the backend over the UI
 * data plane: UiEventMessage { event: 'ui.render', data: { tree } }.
 */
export interface UiRenderPayload {
  panelId: string;
  tree: UiNode;
}
