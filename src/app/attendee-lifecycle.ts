export async function notifyBeforeCleanup(
  sendNotice: () => Promise<void>,
  cleanup: () => Promise<void>,
  onNoticeFailure: () => void,
  timeoutMs = 2_500,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendNotice(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('notice timeout')), timeoutMs);
      }),
    ]);
  } catch {
    onNoticeFailure();
  } finally {
    if (timer) clearTimeout(timer);
  }
  await cleanup();
}
