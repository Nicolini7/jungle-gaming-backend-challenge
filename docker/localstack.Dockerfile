FROM localstack/localstack:4.7.0
COPY --chmod=0755 localstack-init.sh /etc/localstack/init/ready.d/10-jungle-queues.sh
