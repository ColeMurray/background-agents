# Reference build. The context is the output of sandbox:images pack, not the checkout.
ARG BASE_IMAGE=python:3.12-slim-bookworm
FROM ${BASE_IMAGE}
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
