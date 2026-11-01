---
name: commercial-cloud-standalone-accounts
description: 商业化云服务的账号系统是独立账号（邮箱加密码），不依赖 GitHub、Google 等第三方登录；后台负责添加模型接口与查看用户数据
metadata:
  type: project
---

商业化云服务（方案 `docs/plans/2026-11-01-商业化云服务.md`）的账号系统是独立的：用户以邮箱加密码注册和登录，
不接入 GitHub、Google 等第三方登录。管理后台负责添加模型接口（上游地址、key、模型与价格）和查看、管理用户数据。

**Why:** 用户 2026-11-01 指出「账号系统和 github 有啥关系，直接做一个单独的账号系统，然后还有后台管理系统，用于上传模型的接口，监控用户数据」。
此前的方案把 GitHub、Google 登录作为唯一登录方式，并要求用户创建 OAuth 应用。

**How to apply:** 不要再提议第三方登录或要求用户创建 OAuth 应用；上游模型的接口与 key 由后台录入、保存在数据库中，
不写在服务器的环境变量里。参见 [[cloud-repo-local-only]]。
