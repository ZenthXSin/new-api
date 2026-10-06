/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { Component, type ReactNode } from 'react'

type ResponseErrorBoundaryProps = {
  children: ReactNode
  content: string
  final: boolean
}

type ResponseErrorBoundaryState = {
  failed: boolean
  content: string
  final: boolean
}

/** Keep a malformed response readable without taking down the conversation. */
export class ResponseErrorBoundary extends Component<
  ResponseErrorBoundaryProps,
  ResponseErrorBoundaryState
> {
  state: ResponseErrorBoundaryState = {
    failed: false,
    content: this.props.content,
    final: this.props.final,
  }

  static getDerivedStateFromError(): Partial<ResponseErrorBoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: ResponseErrorBoundaryProps,
    state: ResponseErrorBoundaryState
  ): ResponseErrorBoundaryState | null {
    if (props.content !== state.content || props.final !== state.final) {
      return { failed: false, content: props.content, final: props.final }
    }
    return null
  }

  render() {
    if (this.state.failed) {
      return (
        <div className='break-words whitespace-pre-wrap'>
          {this.props.content}
        </div>
      )
    }
    return this.props.children
  }
}
