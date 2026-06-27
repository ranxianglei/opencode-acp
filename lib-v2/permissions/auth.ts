export function isSecureMode(): boolean {
    return !!process.env.OPENCODE_SERVER_PASSWORD
}

export function getAuthorizationHeader(): string | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    if (!password) return undefined

    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
    const credentials = Buffer.from(`${username}:${password}`).toString("base64")
    return `Basic ${credentials}`
}

interface RequestInterceptorManager {
    use(fn: (request: Request) => Request | Promise<Request>): void
}

interface HttpLike {
    interceptors?: { request: RequestInterceptorManager }
}

interface PluginClientLike {
    _client?: HttpLike
    client?: HttpLike
}

export function configureClientAuth<T extends PluginClientLike>(client: T): T {
    const authHeader = getAuthorizationHeader()

    if (!authHeader) {
        return client
    }

    const innerClient = client._client || client.client

    if (innerClient?.interceptors?.request) {
        innerClient.interceptors.request.use((request: Request) => {
            if (!request.headers.has("Authorization")) {
                request.headers.set("Authorization", authHeader)
            }
            return request
        })
    }

    return client
}
