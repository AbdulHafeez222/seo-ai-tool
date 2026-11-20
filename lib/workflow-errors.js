export class WorkflowError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function workflowHandler(asyncHandler, handler) {
  return asyncHandler(async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      res.status(error.status).json({ success: false, code: error.code, message: error.code });
    }
  });
}
