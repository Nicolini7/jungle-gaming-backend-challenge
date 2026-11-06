#!/bin/bash
set -euo pipefail

DLQ_URL=$(awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
COMMAND_URL=$(awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"10"}' --query QueueUrl --output text)
awslocal sqs create-queue --queue-name wager-events.fifo --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

python3 -c 'import json, sys; print(json.dumps({"RedrivePolicy": json.dumps({"deadLetterTargetArn": sys.argv[1], "maxReceiveCount": "5"})}))' "$DLQ_ARN" >/tmp/jungle-redrive.json
awslocal sqs set-queue-attributes --queue-url "$COMMAND_URL" --attributes file:///tmp/jungle-redrive.json
echo 'Jungle command, dead-letter and event queues are ready.'
