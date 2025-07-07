#!/bin/bash

# jpg2avif-py Kubernetes Deployment Script
# This script deploys the jpg2avif-py converter service to the webapps namespace

set -e

echo "🚀 Deploying jpg2avif-py converter service to Kubernetes..."

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ kubectl is not installed or not in PATH"
    exit 1
fi

# Check if we can connect to the cluster
if ! kubectl cluster-info &> /dev/null; then
    echo "❌ Cannot connect to Kubernetes cluster"
    exit 1
fi

# Check if webapps namespace exists
if ! kubectl get namespace webapps &> /dev/null; then
    echo "❌ webapps namespace does not exist"
    exit 1
fi

echo "✅ Prerequisites check passed"

# Deploy components in order
echo "📦 Deploying ConfigMap..."
kubectl apply -f jpg2avif-py-configmap.yaml

echo "📦 Deploying Deployment and Service..."
kubectl apply -f jpg2avif-py-deployment.yaml

echo "📦 Deploying HorizontalPodAutoscaler..."
kubectl apply -f jpg2avif-py-hpa.yaml

echo "📦 Deploying PodDisruptionBudget..."
kubectl apply -f jpg2avif-py-pdb.yaml

echo "⏳ Waiting for deployment to be ready..."
kubectl rollout status deployment/jpg2avif-py -n webapps --timeout=300s

echo "📊 Checking deployment status..."
kubectl get deployment jpg2avif-py -n webapps
kubectl get service jpg2avif-py-service -n webapps
kubectl get hpa jpg2avif-py-hpa -n webapps
kubectl get pdb jpg2avif-py-pdb -n webapps

echo "🔍 Showing pod status..."
kubectl get pods -n webapps -l app=jpg2avif-py

echo "✅ jpg2avif-py deployment completed successfully!"
echo ""
echo "📋 Service Details:"
echo "   Service Name: jpg2avif-py-service"
echo "   Namespace: webapps"
echo "   Internal URL: http://jpg2avif-py-service.webapps.svc.cluster.local:3000"
echo "   Health Check: http://jpg2avif-py-service.webapps.svc.cluster.local:3000/health"
echo ""
echo "🔧 To check logs:"
echo "   kubectl logs -n webapps -l app=jpg2avif-py --tail=100"
echo ""
echo "🔄 To update the API ConfigMap (if needed):"
echo "   kubectl apply -f configmap.yaml"
echo "   kubectl rollout restart deployment/photovault-api -n webapps"
