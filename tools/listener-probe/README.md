# Listener-side Meet probe

This probe measures the latency that a second Meet participant actually hears, including Meet, device, and speaker buffering that server traces cannot see.

Recording requires the informed consent of everyone whose voice may be captured. Files stay local; review your organization’s retention rules before keeping or sharing them.

## Record a meeting

```powershell
node --disable-warning=ExperimentalWarning --experimental-transform-types tools/listener-probe/run.ts record
```

Open `http://127.0.0.1:4317` on the second participant’s device and follow the on-page protocol. Keep speaker volume and device placement fixed between runs. The page exports a WebM recording for audit and a JSON sidecar for measurement.

## Compare meetings

```powershell
node --disable-warning=ExperimentalWarning --experimental-transform-types tools/listener-probe/run.ts report results\meeting-1.json results\meeting-2.json --out results\comparison.md
```

Question latency begins at the listener’s `Q` marker and ends at 60 ms of sustained sound. Stop latency begins at the `W` marker and ends at 300 ms of stable silence. A missing transition is reported as missing, never as zero. Use the WebM to audit questionable markers or unexpected noise.
