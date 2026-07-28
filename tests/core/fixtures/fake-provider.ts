export interface FakeResponse {
  status: number;
  body?: unknown;
}

export interface FakeProvider extends Disposable {
  readonly url: string;
  readonly requests: number;
}

function disposableServer(handler: () => Response | Promise<Response>): FakeProvider {
  let requests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests += 1;
      return handler();
    },
  });

  return {
    url: server.url.toString(),
    get requests() {
      return requests;
    },
    [Symbol.dispose]() {
      void server.stop(true);
    },
  };
}

export function fakeProvider(responses: FakeResponse[]): FakeProvider {
  if (responses.length === 0) throw new Error('fake provider requires at least one response');
  let index = 0;
  return disposableServer(() => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!response) throw new Error('fake provider response sequence exhausted');
    return Response.json(response.body ?? {}, { status: response.status });
  });
}

export function hangingProvider(): FakeProvider {
  return disposableServer(() => new Promise<Response>(() => undefined));
}
