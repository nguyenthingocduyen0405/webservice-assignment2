import { AppError, missing, forbidden, invalidState } from './errors.js';

// 업무 규칙과 트랜잭션 구현 (TODO-01~04).
// actor는 auth.middleware가 DB에서 다시 읽은 로그인 사용자입니다. 요청 본문의 신원·역할·상태는 사용하지 않습니다.
// 검사 순서: (app.js) 인증 → ID·본문 형식 → (service) 대상 존재 → 권한 → 현재 상태 → 정원.
export function createApplicationService(repo) {
  const db=repo.db;

  // 모든 변경 요청은 이 함수 안에서 실행됩니다.
  // BEGIN IMMEDIATE: 트랜잭션 시작 시점에 DB 쓰기 잠금을 먼저 획득합니다.
  //   → 검사(SELECT)와 변경(UPDATE/INSERT) 사이에 다른 연결(다른 서버 프로세스)이 끼어들 수 없습니다.
  // work()가 정상 반환하면 COMMIT, 업무 거부(AppError)나 저장 오류(예: 이력 INSERT 실패)로
  // 예외가 발생하면 ROLLBACK 후 예외를 다시 던집니다. 따라서 상태와 이력은 함께 저장되거나 함께 취소됩니다.
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result=work();
      db.exec('COMMIT');
      return result;
    } catch(e) {
      if(db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }

  // 조건부 UPDATE가 0행이면 그 사이 상태가 바뀐 것이므로 409로 거부합니다(트랜잭션 전체 롤백).
  function change(id,from,to) {
    if(repo.changeStatus(id,from,to)!==1) throw invalidState();
  }

  const isManagerOf=(actor,event)=>actor.role==='MANAGER'&&event.managerId===actor.id;

  return {
    // TODO-01 신청: 행사 존재 → 학생 역할 → 중복 → PENDING 저장 + APPLY 이력
    apply(actor,eventId) {
      return transaction(()=>{
        const event=repo.event(eventId);
        if(!event) throw missing('행사');
        if(actor.role!=='STUDENT') throw forbidden();
        // CANCELLED·REVOKED를 포함한 모든 기존 신청이 중복입니다.
        if(repo.existing(eventId,actor.id)) throw new AppError(409,'ALREADY_APPLIED','이미 이 행사에 신청한 기록이 있습니다.');
        const created=repo.insert(eventId,actor.id);
        repo.addHistory({applicationId:created.id,actorId:actor.id,action:'APPLY',fromStatus:null,toStatus:'PENDING'});
        return created;
      });
    },

    // TODO-02 대기 취소: 신청 존재 → 본인 → PENDING → CANCELLED + CANCEL 이력 (자동 승급 없음)
    cancel(actor,applicationId) {
      return transaction(()=>{
        const app=repo.application(applicationId);
        if(!app) throw missing('신청');
        if(actor.role!=='STUDENT'||app.userId!==actor.id) throw forbidden();
        if(app.status!=='PENDING') throw invalidState();
        change(app.id,'PENDING','CANCELLED');
        repo.addHistory({applicationId:app.id,actorId:actor.id,action:'CANCEL',fromStatus:'PENDING',toStatus:'CANCELLED'});
        return repo.application(app.id);
      });
    },

    // TODO-03 직접 승인: 신청 존재 → 담당 운영자 → PENDING → 정원 → APPROVED + APPROVE 이력
    approve(actor,applicationId) {
      return transaction(()=>{
        const app=repo.application(applicationId);
        if(!app) throw missing('신청');
        const event=repo.event(app.eventId);
        if(!isManagerOf(actor,event)) throw forbidden();
        if(app.status!=='PENDING') throw invalidState();
        // 정원에는 APPROVED만 포함합니다. 같은 트랜잭션(쓰기 잠금) 안에서 다시 셉니다.
        if(repo.approvedCount(event.id)>=event.capacity) throw new AppError(409,'CAPACITY_FULL','정원이 모두 찼습니다.');
        change(app.id,'PENDING','APPROVED');
        repo.addHistory({applicationId:app.id,actorId:actor.id,action:'APPROVE',fromStatus:'PENDING',toStatus:'APPROVED'});
        return repo.application(app.id);
      });
    },

    // TODO-04 승인 취소: 신청 존재 → 담당 운영자 → APPROVED
    //   → REVOKED + REVOKE 이력 → 다음 대기자 1명 선택 → APPROVED + AUTO_APPROVE 이력(cause=REVOKE 이력 ID)
    //   네 개의 저장이 하나의 트랜잭션입니다. 어느 하나라도 실패하면 전부 ROLLBACK됩니다.
    revoke(actor,applicationId,reason) {
      return transaction(()=>{
        const app=repo.application(applicationId);
        if(!app) throw missing('신청');
        const event=repo.event(app.eventId);
        if(!isManagerOf(actor,event)) throw forbidden();
        if(app.status!=='APPROVED') throw invalidState();

        change(app.id,'APPROVED','REVOKED');
        const revokeHistoryId=repo.addHistory({applicationId:app.id,actorId:actor.id,action:'REVOKE',fromStatus:'APPROVED',toStatus:'REVOKED',reason});

        // 승인 취소로 생긴 한 자리만 채웁니다(요청당 최대 1명).
        let promoted=null;
        const next=repo.nextPending(event.id);
        if(next) {
          change(next.id,'PENDING','APPROVED');
          repo.addHistory({applicationId:next.id,actorId:actor.id,action:'AUTO_APPROVE',fromStatus:'PENDING',toStatus:'APPROVED',causeHistoryId:revokeHistoryId});
          promoted=repo.application(next.id);
        }
        return {revoked:repo.application(app.id),promoted};
      });
    }
  };
}
