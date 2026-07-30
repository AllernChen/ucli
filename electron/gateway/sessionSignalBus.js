import { validateGatewayEvent } from './contracts.js'

export class SessionSignalBus {
  constructor({ validate = validateGatewayEvent } = {}) {
    this.validate = validate
    this.listeners = new Set()
  }

  publish(input) {
    const event = Object.freeze(structuredClone(this.validate(input)))
    for (const listener of [...this.listeners]) listener(event)
    return event
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
