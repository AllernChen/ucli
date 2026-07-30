import assert from 'node:assert/strict'
import test from 'node:test'

import { FeishuChannel } from '../electron/gateway/channels/feishuChannel.js'

const CONFIG = {
  channelType: 'feishu',
  appId: 'cli_example',
  appSecret: 'secret-value',
  target: { type: 'group', id: 'oc_group' },
  operatorOpenIds: ['ou_operator']
}

function fakeSdk() {
  return {
    botIdentity: { openId: 'ou_bot', name: 'UCLI Bot' },
    connectCount: 0,
    disconnectCount: 0,
    sent: [],
    updates: [],
    reactions: [],
    on(handlers) {
      this.handlers = handlers
      return () => { this.unsubscribed = true }
    },
    async connect() { this.connectCount += 1 },
    async disconnect() { this.disconnectCount += 1 },
    async send(targetId, input, options) {
      if (this.sendError) throw this.sendError
      this.sent.push({ targetId, input, options })
      return { messageId: `message-${this.sent.length}` }
    },
    async updateCard(messageId, card) {
      if (this.updateError) throw this.updateError
      this.updates.push({ messageId, card })
    },
    async addReaction(messageId, emojiType) {
      if (this.reactionError) throw this.reactionError
      const reactionId = `reaction-${this.reactions.length + 1}`
      this.reactions.push({ messageId, emojiType, reactionId })
      return reactionId
    },
    async removeReaction(messageId, reactionId) {
      if (this.reactionError) throw this.reactionError
      this.removedReaction = { messageId, reactionId }
    }
  }
}

test('Feishu channel configures deterministic WebSocket policy and lifecycle once', async () => {
  const sdk = fakeSdk()
  let options
  const channel = new FeishuChannel({
    createLarkChannel: (value) => {
      options = value
      return sdk
    }
  })

  const identity = await channel.connect(CONFIG)
  await channel.disconnect()

  assert.deepEqual(identity, { openId: 'ou_bot', name: 'UCLI Bot' })
  assert.equal(sdk.connectCount, 1)
  assert.equal(sdk.disconnectCount, 1)
  assert.equal(sdk.unsubscribed, true)
  assert.deepEqual(options, {
    appId: 'cli_example',
    appSecret: 'secret-value',
    transport: 'websocket',
    handshakeTimeoutMs: 15000,
    policy: {
      requireMention: false,
      dmMode: 'allowlist',
      dmAllowlist: ['ou_operator'],
      groupAllowlist: ['oc_group'],
      respondToMentionAll: false
    },
    safety: {
      dedup: { ttl: 43200000, maxEntries: 5000 },
      staleMessageWindowMs: 1800000,
      chatQueue: { enabled: true }
    },
    includeRawInMessage: false,
    includeRawEvent: false,
    source: 'ucli-gateway'
  })
})

test('unbound Feishu channel listens for an explicit binding request without a target allowlist', async () => {
  const sdk = fakeSdk()
  sdk.getChatInfo = async () => ({
    chatId: 'oc_group',
    chatType: 'group',
    name: '研发群'
  })
  let options
  const channel = new FeishuChannel({
    createLarkChannel: (value) => {
      options = value
      return sdk
    }
  })

  await channel.connect({
    channelType: 'feishu',
    appId: 'cli_example',
    appSecret: 'secret-value',
    target: null,
    operatorOpenIds: []
  })

  assert.deepEqual(options.policy, {
    requireMention: true,
    dmMode: 'open',
    dmAllowlist: [],
    groupAllowlist: [],
    respondToMentionAll: false
  })
  assert.deepEqual(await channel.resolveBindingCandidate({
    messageId: 'message-1',
    chatId: 'oc_group',
    chatType: 'group',
    senderOpenId: 'ou_operator',
    senderName: '张三'
  }), {
    target: { type: 'group', id: 'oc_group', name: '研发群' },
    operator: { openId: 'ou_operator', name: '张三' }
  })

  await channel.sendBindingNotice({
    messageId: 'message-1',
    chatId: 'oc_group',
    chatType: 'group'
  }, {
    message: '请在 UCLI 中确认绑定。'
  })
  assert.equal(sdk.sent[0].targetId, 'oc_group')
  assert.deepEqual(sdk.sent[0].options, {
    replyTo: 'message-1',
    replyInThread: true
  })
  await channel.disconnect()
})

test('inbound SDK events are normalized and scheduled without awaiting Gateway work', async () => {
  const sdk = fakeSdk()
  const scheduled = []
  const channel = new FeishuChannel({
    createLarkChannel: () => sdk,
    schedule: (work) => scheduled.push(work)
  })
  const messages = []
  const actions = []
  const statuses = []
  channel.onUserMessage((message) => messages.push(message))
  channel.onAction((action) => actions.push(action))
  channel.onStatus((status) => statuses.push(status))
  await channel.connect(CONFIG)

  assert.equal(sdk.handlers.message({
    messageId: 'message-1',
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_operator',
    content: 'continue',
    rawContentType: 'text',
    replyToMessageId: 'decision-message',
    rootId: 'root-1',
    threadId: 'thread-1'
  }), undefined)
  sdk.handlers.message({
    messageId: 'message-2',
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_operator',
    content: '[image]',
    rawContentType: 'image',
    resources: [{ type: 'image', fileKey: 'file-key' }]
  })
  sdk.handlers.cardAction({
    messageId: 'card-message',
    chatId: 'oc_group',
    operator: { openId: 'ou_operator', name: 'Operator' },
    action: {
      tag: 'button',
      value: { integration: 'ucli-gateway', token: 'opaque-action' }
    }
  })
  sdk.handlers.reconnecting()
  sdk.handlers.reconnected()
  sdk.handlers.error(Object.assign(new Error('denied'), { code: 'permission_denied' }))

  assert.deepEqual(messages, [])
  assert.deepEqual(actions, [])
  for (const work of scheduled) await work()
  assert.deepEqual(messages[0], {
    messageId: 'message-1',
    chatId: 'oc_group',
    chatType: 'group',
    senderOpenId: 'ou_operator',
    senderName: '',
    text: 'continue',
    rawContentType: 'text',
    supported: true,
    replyToMessageId: 'decision-message',
    rootId: 'root-1',
    threadId: 'thread-1'
  })
  assert.equal(messages[1].supported, false)
  assert.equal(messages[1].text, '')
  assert.equal(JSON.stringify(messages[1]).includes('file-key'), false)
  assert.deepEqual(actions[0], {
    messageId: 'card-message',
    chatId: 'oc_group',
    senderOpenId: 'ou_operator',
    token: 'opaque-action'
  })
  assert.deepEqual(statuses.map((status) => status.type), [
    'reconnecting',
    'reconnected',
    'error'
  ])
  assert.equal(statuses[2].errorCode, 'permission_denied')
  await channel.disconnect()
})

test('outbound cards use thread replies and failures expose stable error codes', async () => {
  const sdk = fakeSdk()
  const channel = new FeishuChannel({ createLarkChannel: () => sdk })
  await channel.connect(CONFIG)
  const card = { schema: '2.0', body: { elements: [] } }

  assert.deepEqual(await channel.sendCard(card, { replyTo: 'root-1' }), {
    messageId: 'message-1'
  })
  assert.deepEqual(sdk.sent[0], {
    targetId: 'oc_group',
    input: { card },
    options: { replyTo: 'root-1', replyInThread: true }
  })
  await channel.updateCard('root-1', card)
  assert.deepEqual(sdk.updates[0], { messageId: 'root-1', card })

  for (const code of [
    'permission_denied',
    'target_revoked',
    'rate_limited',
    'send_timeout'
  ]) {
    sdk.sendError = Object.assign(new Error(code), { code })
    await assert.rejects(channel.sendCard(card), { code })
  }
  sdk.sendError = null
  await channel.disconnect()
  await assert.rejects(channel.sendCard(card), { code: 'not_connected' })
})

test('reaction failures never fail routing and successful reaction IDs stay in memory', async () => {
  const sdk = fakeSdk()
  const channel = new FeishuChannel({ createLarkChannel: () => sdk })
  await channel.connect(CONFIG)

  assert.equal(await channel.addReaction('message-1', 'OnIt'), 'reaction-1')
  assert.equal(await channel.removeReaction('message-1', 'OnIt'), true)
  assert.deepEqual(sdk.removedReaction, {
    messageId: 'message-1',
    reactionId: 'reaction-1'
  })

  sdk.reactionError = new Error('reaction denied')
  assert.equal(await channel.addReaction('message-2', 'Done'), null)
  assert.equal(await channel.removeReaction('message-2', 'Done'), false)
  await channel.disconnect()
})
