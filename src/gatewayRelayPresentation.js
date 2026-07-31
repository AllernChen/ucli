const RELAY_STATES = {
  off: ['未选择转发', '点击选择此会话进行 Gateway 转发', 'default'],
  switching: ['正在更新', '正在保存此会话的转发选择', 'blue'],
  paused: ['已选择，Gateway 已关闭', '开启全局 Gateway 后将开始转发', 'blue'],
  waiting_binding: ['已选择，等待飞书绑定', '完成飞书绑定后将开始转发', 'orange'],
  waiting_connection: ['已选择，等待连接', 'Gateway 连接完成后将开始转发', 'orange'],
  waiting_session: ['已选择，等待会话', '会话可运行后将开始转发', 'orange'],
  forwarding: ['正在转发', '此会话正在通过 Gateway 转发', 'green'],
  error: ['已选择，Gateway 异常', '请打开 Gateway 设置检查连接状态', 'red']
}

export function deriveGatewayRelayControl({ session, gatewayPhase, pending }) {
  const selected = session?.relayEnabled === true
  let state

  if (pending) {
    state = 'switching'
  } else if (!selected) {
    state = 'off'
  } else if (gatewayPhase === 'error') {
    state = 'error'
  } else if (gatewayPhase === 'off') {
    state = 'paused'
  } else if (gatewayPhase === 'waiting_binding') {
    state = 'waiting_binding'
  } else if (gatewayPhase === 'connecting' || gatewayPhase === 'reconnecting') {
    state = 'waiting_connection'
  } else if (
    gatewayPhase === 'connected' &&
    (session.routeStatus === 'ready' || session.routeStatus === 'active')
  ) {
    state = 'forwarding'
  } else {
    state = 'waiting_session'
  }

  const [label, tooltip, tone] = RELAY_STATES[state]
  return {
    selected,
    effective: state === 'forwarding',
    state,
    label,
    tooltip,
    tone,
    nextEnabled: !selected
  }
}
