export function usageMetricValue(bucket, metric) {
  const value = Number(bucket?.[metric])
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function buildUsageTrendGeometry({ buckets, metric, width, height, padding }) {
  const values = buckets.map(bucket => usageMetricValue(bucket, metric))
  const maxValue = Math.max(0, ...values)
  const baseline = height - padding.bottom
  const drawableHeight = Math.max(0, baseline - padding.top)
  const count = Math.max(1, buckets.length)
  const availableWidth = Math.max(0, width - padding.left - padding.right)
  const slotWidth = availableWidth / count
  const barWidth = Math.max(2, Math.min(42, slotWidth * 0.7))
  const labelInterval = Math.max(1, Math.ceil(count / 8))
  const bars = buckets.map((bucket, index) => {
    const value = values[index]
    const barHeight = maxValue > 0 ? (value / maxValue) * drawableHeight : 0
    return {
      index,
      key: bucket.start ?? `${bucket.label}-${index}`,
      label: bucket.label || `第 ${index + 1} 桶`,
      value,
      x: padding.left + index * slotWidth + (slotWidth - barWidth) / 2,
      y: baseline - barHeight,
      width: barWidth,
      height: barHeight,
      showLabel: index % labelInterval === 0 || index === buckets.length - 1
    }
  })
  return { maxValue, baseline, bars }
}
