# The context is the allowlisted output of sandbox:images pack, never the checkout.
ARG BASE_IMAGE=python:3.12-slim-bookworm
FROM ${BASE_IMAGE} AS installed
COPY image-config.sh /tmp/openinspect-image/image-config.sh
COPY packages/sandbox-images/install/install.sh packages/sandbox-images/install/common.sh /tmp/openinspect-image/packages/sandbox-images/install/
COPY packages/sandbox-images/install/os /tmp/openinspect-image/packages/sandbox-images/install/os
RUN bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh os
COPY packages/sandbox-images/install/languages.sh /tmp/openinspect-image/packages/sandbox-images/install/languages.sh
RUN bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh languages
COPY packages/sandbox-images/locks/tools /tmp/openinspect-image/packages/sandbox-images/locks/tools
COPY packages/sandbox-images/locks/plugins /tmp/openinspect-image/packages/sandbox-images/locks/plugins
COPY packages/sandbox-images/install/tools.sh /tmp/openinspect-image/packages/sandbox-images/install/tools.sh
RUN bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh tools
COPY . /tmp/openinspect-image
RUN bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh runtime filesystem && /opt/openinspect/python/bin/python /tmp/openinspect-image/packages/sandbox-images/verify/smoke_test.py install
WORKDIR /workspace
CMD ["/opt/openinspect/python/bin/python", "/app/verify/smoke_test.py", "verify"]

# Provider runtime overlay. Keep the reference target's smoke-test CMD unchanged.
FROM installed AS daytona-runtime
ARG SANDBOX_VERSION
ARG OI_ENV_HOME
ARG OI_ENV_XDG_CONFIG_HOME
ARG OI_ENV_NODE_ENV
ARG OI_ENV_PYTHONPATH
ARG OI_ENV_NODE_PATH
ARG OI_ENV_PATH
ARG OI_ENV_NPM_CONFIG_PREFIX
ARG OI_ENV_NPM_CONFIG_CACHE
ARG OI_ENV_PNPM_HOME
ARG OI_ENV_OPENINSPECT_BIN_INSTALL_DIR
ARG OI_ENV_OI_SCM_CRED_CACHE_DIR
ENV SANDBOX_VERSION=${SANDBOX_VERSION} HOME=${OI_ENV_HOME} \
    XDG_CONFIG_HOME=${OI_ENV_XDG_CONFIG_HOME} NODE_ENV=${OI_ENV_NODE_ENV} \
    PYTHONPATH=${OI_ENV_PYTHONPATH} NODE_PATH=${OI_ENV_NODE_PATH} PATH=${OI_ENV_PATH} \
    npm_config_prefix=${OI_ENV_NPM_CONFIG_PREFIX} npm_config_cache=${OI_ENV_NPM_CONFIG_CACHE} \
    PNPM_HOME=${OI_ENV_PNPM_HOME} OPENINSPECT_BIN_INSTALL_DIR=${OI_ENV_OPENINSPECT_BIN_INSTALL_DIR} \
    OI_SCM_CRED_CACHE_DIR=${OI_ENV_OI_SCM_CRED_CACHE_DIR}
ENTRYPOINT ["/opt/openinspect/python/bin/python", "-m", "sandbox_runtime.entrypoint"]
CMD []

# Keep the default/reference build behavior stable for all other providers.
FROM installed AS reference
