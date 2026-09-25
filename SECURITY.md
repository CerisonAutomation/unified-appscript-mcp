# Security policy

Report vulnerabilities privately through GitHub's security advisory interface. Do not open a public issue containing credentials or exploit details.

Never commit OAuth client files, tokens, service-account keys or `.env` files. The server only sends bearer tokens to allowlisted HTTPS Google API hosts. Review requested OAuth scopes and use the smallest profile that satisfies the task.
