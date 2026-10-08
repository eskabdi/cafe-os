import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorState } from './states'

interface Props {
  children: ReactNode
  /** Changing this value (e.g. the pathname) clears a caught error, so navigating away recovers. */
  resetKey?: string
}
interface State {
  failed: boolean
}

/**
 * Catches render errors below the shell and shows a fixed, safe message. The error object is never rendered (it may carry
 * server or SQL text); it only goes to the console in development.
 */
export class ShellErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error('Unhandled UI error', error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render() {
    if (this.state.failed) {
      return (
        <ErrorState onRetry={() => this.setState({ failed: false })}>
          <p>This page could not be displayed. Try again, or go back to the home page.</p>
        </ErrorState>
      )
    }
    return this.props.children
  }
}
