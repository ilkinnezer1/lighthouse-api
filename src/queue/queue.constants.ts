/**
 * Redis Stream key. Worker's consumer group reads from here.
 */
export const BUILD_QUEUE_STREAM = 'jobs:build';

/**
 * Stream entry field carrying the deployment ID. Go reads this field.
 */
export const FIELD_DEPLOYMENT_ID = 'deploymentId';

export const cancelChannel = (deploymentId: string): string => {
  return `cancel:deploy:${deploymentId}`;
};
