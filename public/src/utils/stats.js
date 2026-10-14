// Replicate statistics for a single parameter row. Returns rounded avg,
// stddev (sample stddev, n-1 denominator), and an "OK" / "ALERT" message
// relative to the standard when one is supplied.

export function computeRepStats(vals, std) {
  const nums = vals
    .map(v => v === "" || v == null ? null : Number(v))
    .filter(v => v !== null && !Number.isNaN(v));
  if (nums.length === 0) return { avg: "", stddev: "", msg: "" };

  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  let stddev = "";
  if (nums.length > 1) {
    const variance = nums.reduce((a, b) => a + (b - avg) * (b - avg), 0) / (nums.length - 1);
    stddev = Math.sqrt(variance);
  }

  const stdNum = std === "" || std == null ? null : Number(std);
  const msg = (stdNum != null && !Number.isNaN(stdNum))
    ? (avg < stdNum ? "OK" : "ALERT")
    : "";

  return {
    avg: Number.isFinite(avg) ? Number(avg.toFixed(3)) : "",
    stddev: stddev === "" ? "" : Number(stddev.toFixed(3)),
    msg
  };
}
