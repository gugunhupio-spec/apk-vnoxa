/**
 * Kesalahan yang aman ditampilkan ke pengguna (pesan Bahasa Indonesia).
 */
export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export class GithubError extends HttpError {
  constructor(status, message, details = null) {
    super(status, message, details);
    this.name = 'GithubError';
  }
}
