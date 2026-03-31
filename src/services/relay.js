/**
 * Relay command queue.
 * The ESP32 polls GET /device/poll — this module holds the pending command
 * per device so the ESP32 picks it up on its next poll cycle.
 */

// Map<deviceId, { command: 'ON'|'OFF', sessionId: string|null }>
const pendingCommands = new Map();

function queueRelayOn(deviceId, sessionId) {
  pendingCommands.set(deviceId, { command: 'ON', sessionId });
}

function queueRelayOff(deviceId, sessionId) {
  pendingCommands.set(deviceId, { command: 'OFF', sessionId });
}

/**
 * Called by the device poll endpoint. Returns and clears the pending command.
 * If no command is queued, returns null (device stays in current state).
 */
function consumeCommand(deviceId) {
  const cmd = pendingCommands.get(deviceId) || null;
  if (cmd) pendingCommands.delete(deviceId);
  return cmd;
}

function hasPendingCommand(deviceId) {
  return pendingCommands.has(deviceId);
}

module.exports = { queueRelayOn, queueRelayOff, consumeCommand, hasPendingCommand };
