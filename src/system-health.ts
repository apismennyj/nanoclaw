import os from 'os';
import { execSync } from 'child_process';
import { formatLocalTime } from './timezone.js';

export interface SystemHealth {
  timestamp: string;
  uptime: string;
  memoryUsage: string;
  cpuLoad: string;
  storageUsage: string;
}

/**
 * Get disk usage for the root filesystem
 */
function getDiskUsage(): string {
  try {
    // Use df to get disk usage of root filesystem
    const output = execSync('df -h / 2>/dev/null | tail -1', {
      encoding: 'utf-8',
    }).trim();
    const parts = output.split(/\s+/);
    if (parts.length >= 4) {
      const used = parts[2];
      const total = parts[1];
      const percent = parts[4];
      return `${used} / ${total} (${percent})`;
    }
  } catch {
    // Fallback if df fails
  }
  return 'N/A';
}

/**
 * Gather system health information
 */
export function getSystemHealth(timezone: string): SystemHealth {
  const now = new Date();
  const timestamp = formatLocalTime(now.toISOString(), timezone);

  // System uptime in seconds → convert to readable format
  const uptimeSeconds = os.uptime();
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  let uptimeStr = '';
  if (days > 0) uptimeStr += `${days}d `;
  if (hours > 0 || days > 0) uptimeStr += `${hours}h `;
  uptimeStr += `${minutes}m`;

  // Memory usage (free / total)
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const memoryUsageStr = `${(usedMem / 1024 / 1024 / 1024).toFixed(2)}GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(2)}GB (${memPercent}%)`;

  // CPU load average
  const loadAvg = os.loadavg();
  const cpuLoadStr = `${loadAvg[0].toFixed(2)} ${loadAvg[1].toFixed(2)} ${loadAvg[2].toFixed(2)} (1m 5m 15m)`;

  // Disk usage
  const storageUsageStr = getDiskUsage();

  return {
    timestamp,
    uptime: uptimeStr,
    memoryUsage: memoryUsageStr,
    cpuLoad: cpuLoadStr,
    storageUsage: storageUsageStr,
  };
}

/**
 * Format system health as a message
 */
export function formatHealthMessage(
  health: SystemHealth,
  botName: string = 'NanoClaw',
): string {
  return `✅ *${botName} started*\n\n🕐 Time: ${health.timestamp}\n⏱️ Uptime: ${health.uptime}\n💾 Memory: ${health.memoryUsage}\n🗄️ Storage: ${health.storageUsage}\n📊 CPU Load: ${health.cpuLoad}`;
}
