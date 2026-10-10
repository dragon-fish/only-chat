import type { InjectionKey } from 'vue'

/**
 * Lets something rendered inside a conversation — a plugin's tool card — speak as the user, the
 * same as typing into the composer and pressing send. Provided by the chat view only; anywhere else
 * (an audit, a shared transcript) it is absent and such controls stay disabled.
 */
export interface UserMessageSender {
  /** Reactive: false while a reply streams or the composer itself could not send. */
  readonly available: boolean
  /** False, and nothing sent, when not available. */
  send(text: string): boolean
}

export const USER_MESSAGE_SENDER: InjectionKey<UserMessageSender> = Symbol('user-message-sender')
