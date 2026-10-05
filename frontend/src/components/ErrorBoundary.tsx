import React, { ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown): void {
    // Keep error available in the console during local debugging.
    console.error(error);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return <p className="error-line">Could not compute policy. Try again.</p>;
    }

    return this.props.children;
  }
}
