"""Compatibility shim for Starlette TestClient in sandboxed release checks.

The local release-check sandbox can block AnyIO's cross-thread portal wakeups,
which leaves Starlette's default synchronous TestClient waiting forever.  The
wallet API tests only need request/response ASGI behavior, so this patch routes
TestClient requests through httpx's in-thread ASGI transport during pytest.
"""

from __future__ import annotations

import asyncio
from typing import Any


def _patch_starlette_testclient() -> None:
    try:
        import fastapi.routing
        import httpx
        import starlette.concurrency
        import starlette.routing
        from starlette.testclient import TestClient
    except Exception:  # pragma: no cover - optional test dependency missing.
        return

    async def in_threadpool_inline(func: Any, *args: Any, **kwargs: Any) -> Any:
        return func(*args, **kwargs)

    starlette.concurrency.run_in_threadpool = in_threadpool_inline
    starlette.routing.run_in_threadpool = in_threadpool_inline
    fastapi.routing.run_in_threadpool = in_threadpool_inline

    if getattr(TestClient, "_wallet_in_thread_asgi_patch", False):
        return

    original_init = TestClient.__init__

    def patched_init(self: Any, app: Any, *args: Any, **kwargs: Any) -> None:
        self._wallet_raise_server_exceptions = kwargs.get(
            "raise_server_exceptions",
            args[1] if len(args) > 1 else True,
        )
        self._wallet_root_path = kwargs.get("root_path", args[2] if len(args) > 2 else "")
        original_init(self, app, *args, **kwargs)

    def patched_request(
        self: Any,
        method: str,
        url: httpx._types.URLTypes,
        *,
        content: httpx._types.RequestContent | None = None,
        data: httpx._types.RequestData | None = None,
        files: httpx._types.RequestFiles | None = None,
        json: Any = None,
        params: httpx._types.QueryParamTypes | None = None,
        headers: httpx._types.HeaderTypes | None = None,
        cookies: httpx._types.CookieTypes | None = None,
        auth: httpx._types.AuthTypes | httpx._client.UseClientDefault = httpx.USE_CLIENT_DEFAULT,
        follow_redirects: bool | None = None,
        allow_redirects: bool | None = None,
        timeout: httpx._types.TimeoutTypes | httpx._client.UseClientDefault = httpx.USE_CLIENT_DEFAULT,
        extensions: dict[str, Any] | None = None,
    ) -> httpx.Response:
        del extensions
        merged_url = self._merge_url(url)
        if hasattr(self, "_choose_redirect_arg"):
            redirect = self._choose_redirect_arg(follow_redirects, allow_redirects)
        elif follow_redirects is not None:
            redirect = follow_redirects
        elif allow_redirects is not None:
            redirect = allow_redirects
        else:
            redirect = getattr(self, "follow_redirects", True)
        merged_headers = httpx.Headers(self.headers)
        if headers is not None:
            merged_headers.update(headers)

        async def run_request() -> httpx.Response:
            transport = httpx.ASGITransport(
                app=self.app,
                root_path=getattr(self, "_wallet_root_path", ""),
                raise_app_exceptions=getattr(self, "_wallet_raise_server_exceptions", True),
            )
            async with httpx.AsyncClient(
                transport=transport,
                base_url=str(self.base_url),
                follow_redirects=redirect,
                cookies=self.cookies,
            ) as client:
                request_kwargs: dict[str, Any] = {
                    "content": content,
                    "data": data,
                    "files": files,
                    "json": json,
                    "params": params,
                    "headers": merged_headers,
                    "cookies": cookies,
                    "follow_redirects": redirect,
                }
                if auth is not httpx.USE_CLIENT_DEFAULT:
                    request_kwargs["auth"] = auth
                if timeout is not httpx.USE_CLIENT_DEFAULT:
                    request_kwargs["timeout"] = timeout
                response = await client.request(method, merged_url, **request_kwargs)
                await response.aread()
                return response

        return asyncio.run(run_request())

    def patched_enter(self: Any) -> Any:
        return self

    def patched_exit(self: Any, *exc: Any) -> None:
        self.close()

    TestClient.__init__ = patched_init
    TestClient.request = patched_request
    TestClient.__enter__ = patched_enter
    TestClient.__exit__ = patched_exit
    TestClient._wallet_in_thread_asgi_patch = True


_patch_starlette_testclient()
