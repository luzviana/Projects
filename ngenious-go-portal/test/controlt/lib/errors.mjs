export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function publicError(error) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return {
    status: 500,
    body: { error: "internal_error", message: "The request could not be completed." },
  };
}
