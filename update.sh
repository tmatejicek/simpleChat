#!/bin/bash

git fetch origin main
git reset --hard origin/main
git pull origin main
pm2 restart all