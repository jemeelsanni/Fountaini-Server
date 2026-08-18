# School Management Portal — Product Requirements Document (PRD)

## 1. Project Title

School Management Portal

## 2. Project Description

The School Management Portal is a unified web-based platform designed to centralize the academic, administrative, financial, attendance, and communication activities of the school.

The platform will provide different access levels for administrators/proprietors, teachers, students, parents, bursary/accounts staff, and Madrassah instructors while maintaining a unified portal experience across the school's academic and Madrassah arms.

The system will reduce dependence on manual paperwork and disconnected processes by providing a centralized platform for managing student information, academic results, attendance, fees, timetables, admissions enquiries, and Madrassah progress.

Parents with multiple children will be able to access all of their children's information from a single account.

The initial release will focus on the core operations required by the school. Features such as online examinations, e-learning, online admissions, and transport/hostel management will not be included in the initial MVP.

## 3. Goals & Objectives

The primary goals of the system are to:

- Centralize school records and administrative processes.
- Provide a unified portal for all school users.
- Allow parents to monitor all their children from one account.
- Automate academic result calculations.
- Simplify teacher score and attendance entry.
- Provide parents and students with access to academic results and timetables.
- Track Madrassah Qur'an memorization and related progress.
- Improve fee tracking and communication with parents.
- Introduce QR code attendance tracking.
- Reduce manual paperwork and administrative workload.
- Provide a reliable foundation for future school-management features.

## 4. Users & Roles

The system will support the following user roles:

### 4.1 Administrator / Proprietor

Responsible for managing the overall school system.

The administrator should be able to:

- Manage users and permissions.
- Manage students and teachers.
- Manage classes and subjects.
- Manage academic sessions and terms.
- Manage results.
- Monitor attendance.
- Manage fee records.
- Manage admissions enquiries.
- View reports and school-wide information.

### 4.2 Teacher

Teachers will use the same unified dashboard regardless of whether they teach regular academic subjects or Madrassah subjects.

Teachers should be able to:

- View assigned classes and subjects.
- Enter Continuous Assessment scores.
- Enter examination scores.
- View relevant student information.
- Record attendance through the approved attendance system.
- View class timetables.
- Manage Madrassah/Qur'an progress where applicable.

### 4.3 Madrassah Instructor

Madrassah instructors will use the same teacher dashboard rather than having a separate portal.

They will have access to Madrassah-specific functionality such as:

- Qur'an memorization tracking.
- Surah progress.
- Juz' progress.
- Tajweed-related progress where applicable.

### 4.4 Student

Students should be able to:

- View their profile information.
- View academic results.
- View report cards.
- View timetable.
- View attendance records where permitted.
- View relevant Madrassah progress.

### 4.5 Parent

Parents should be able to:

- View their children's information.
- Access multiple children from one account.
- View academic results and report cards.
- View timetables.
- View attendance information.
- View fee/payment information.
- Receive notifications/reminders for outstanding fees.

### 4.6 Bursar / Accounts Staff

Accounts staff should be able to:

- Manage student fee records.
- Record bank-transfer payments.
- Track outstanding balances.
- Confirm payments.
- Generate relevant financial records and reports.
- Trigger or manage fee reminders.

## 5. Portal Structure

The school will use **one unified portal** rather than separate portals for different school arms.

Users will see functionality based on their role and permissions.

For example:

- Teachers and Madrassah instructors use the same teacher dashboard.
- Parents can manage multiple children from one account.
- Administrators can access school-wide management features.
- Students access their own academic information.

The system should maintain a consistent interface while dynamically displaying the sections relevant to each user.

## 6. Core Features

### 6.1 Authentication & User Management

**Description**

The system will provide secure authentication and role-based access to the portal.

**Intent**

To ensure that users can only access information and functionality appropriate to their role.

**Requirements**

- User login.
- Secure authentication.
- Role-based access control.
- Password management.
- User activation/deactivation.
- Different permissions based on role.
- Session management.
- Parent accounts capable of being associated with multiple students.

## 7. Student Management

**Description**

A centralized student management system for storing and managing student records.

**Intent**

To provide the school with a single source of truth for student information.

**Requirements**

Administrators should be able to:

- Create student records.
- Edit student information.
- View student profiles.
- Assign students to classes.
- Associate students with parents/guardians.
- Manage student academic information.
- View relevant attendance, results, fees, and Madrassah records.

The student profile should act as a central point from which authorized users can access relevant student information.

## 8. Parent & Family Management

**Description**

Parents should have a single account through which they can access information for all children registered under them.

**Intent**

To avoid requiring parents with multiple children to maintain separate accounts.

**Requirements**

- One parent account can be linked to multiple students.
- Parent can switch between children.
- Parent can view each child's results.
- Parent can view each child's timetable.
- Parent can view each child's attendance.
- Parent can view each child's fee information.
- Access must be restricted to the parent's linked children.

## 9. Admissions / Enquiry Management

**Description**

The portal will provide a basic admission enquiry system rather than a complete online admission application process.

**Intent**

To allow prospective parents/guardians to express interest in admission and provide the school with a way to manage enquiries.

**Requirements**

- Public admission enquiry form.
- Capture prospective student's information.
- Capture parent/guardian contact information.
- Record enquiry date.
- Track enquiry status.
- Allow authorized staff to view and manage enquiries.
- Display September intake information where appropriate.

**Deferred**

The following are not included in the initial version:

- Online admission applications.
- Document uploads.
- Online entrance examinations.
- Assessment booking.
- Automated admission letters.
- Automated offer letters.

## 10. Academic Management

### 10.1 Classes & Subjects

The system should allow authorized administrators to:

- Create academic classes.
- Assign students to classes.
- Create subjects.
- Assign subjects to classes.
- Assign teachers to subjects/classes.
- Manage academic sessions and terms.

**Intent**

To establish the academic structure required for attendance, results, timetables, and teacher activities.

## 11. Continuous Assessment & Examination Scores

**Description**

Teachers will have a dedicated interface for entering student academic scores.

**Intent**

To replace manual score collection and simplify the process of preparing student results.

**Requirements**

Teachers should be able to:

- Select an assigned class.
- Select a subject.
- Select the relevant term/session.
- Enter Continuous Assessment scores.
- Enter examination scores.
- Edit scores where permitted.
- Submit scores for processing.

The system should validate entered scores according to configured maximum values.

## 12. Automatic Result Calculation

**Description**

The system will automatically calculate student results based on configured academic rules.

**Intent**

To reduce calculation errors and minimize the amount of manual work required from teachers and administrators.

**Requirements**

The system should:

- Calculate total scores.
- Calculate grades.
- Apply configured grading rules.
- Generate term results.
- Generate session results where applicable.
- Produce report cards.
- Allow authorized administrators to review results.
- Prevent unauthorized modification of finalized results.

The grading structure should be configurable so that it can be changed if the school's grading policy changes.

## 13. Result Checker & Report Cards

**Description**

Students and parents will be able to access academic results through the portal.

**Intent**

To provide convenient access to student academic performance without requiring physical collection of results.

**Requirements**

Authorized users should be able to:

- View term results.
- View session results.
- View subject scores.
- View grades.
- View overall performance.
- View/download report cards where supported.

Parents should only be able to access results belonging to their linked children.

## 14. Madrassah / Qur'an Progress Tracking

**Description**

The system will include Madrassah-specific academic tracking within the existing teacher dashboard.

**Intent**

To digitally track Qur'an memorization and related Madrassah progress instead of maintaining separate manual records.

**Requirements**

Teachers/instructors should be able to record:

- Surahs completed.
- Qur'an memorization progress.
- Juz' covered.
- Tajweed progress/assessment.
- Relevant notes or progress information.

The system should allow progress to be associated with the individual student and displayed to authorized parents, students, and staff.

## 15. Timetable Management

**Description**

The school will be able to manage class and subject timetables.

**Intent**

To provide students, parents, and teachers with an accessible view of their schedules.

**Requirements**

Administrators should be able to:

- Create timetables.
- Assign subjects to time slots.
- Assign teachers.
- Assign classes.
- Define school days and periods.

Students and parents should be able to view the appropriate timetable.

Teachers should be able to view their assigned schedules.

## 16. Fee & Payment Management

**Description**

The portal will provide fee tracking and bank-transfer payment recording.

**Intent**

To give the school and parents a clear view of fee obligations and payment status.

**Payment Method**

The initial payment method will be **bank transfer**.

The system will not initially require an online payment gateway.

**Requirements**

Accounts staff should be able to:

- Create/manage fee obligations.
- Record bank-transfer payments.
- Confirm payments.
- View outstanding balances.
- Track payment history.
- View student financial records.
- Generate relevant payment records/receipts where required.

Parents should be able to:

- View applicable fees.
- View payment history.
- View outstanding balances.
- View payment status.

## 17. Fee Reminders & Notifications

**Description**

The system should notify parents about outstanding fee obligations.

**Intent**

To reduce delayed payments and improve communication between the school and parents.

**Requirements**

The system should support automatic reminders through configured communication channels.

Potential channels include:

- SMS
- Email
- WhatsApp

The exact notification provider/channel should be determined during technical planning.

Notifications may include:

- Outstanding fee reminders.
- Payment confirmation.
- Important account/financial notifications.

## 18. QR Code Attendance

**Description**

The school will use a QR-code-based attendance system to record student attendance digitally.

Each student will have a unique QR code that can be scanned using an authorized device to record attendance.

**Intent**

To provide a fast, simple, and scalable digital attendance system while reducing manual attendance marking and minimizing opportunities for attendance fraud.

The QR-based approach will be used for the initial version instead of biometric attendance.

**Requirements**

The attendance system should:

- Assign each student a unique QR code.
- Allow authorized staff to scan student QR codes.
- Automatically identify the student from the QR code.
- Record the attendance date and time.
- Associate attendance with the correct class/session.
- Prevent unauthorized users from recording attendance.
- Prevent duplicate attendance records for the same attendance session.
- Allow authorized staff to view and correct attendance records where permitted.
- Maintain an attendance history for each student.
- Support attendance reports.

**Attendance Validation**

The system should validate attendance before accepting a scan.

The initial validation should consider:

- Valid student QR code.
- Authorized attendance session.
- Correct date/time.
- Student's class/session.
- Whether the student has already been marked present.

The system should be designed so additional validation methods, such as location verification, can be introduced later.

**Attendance Flow**

Student presents QR code → Authorized device scans QR code → System identifies student → System validates attendance → Attendance is recorded → Student receives confirmation

The exact scanning workflow will be finalized during UI/UX and technical design.

## 19. Attendance Records & Reporting

Authorized users should be able to:

- View individual student attendance history.
- View class attendance.
- Filter attendance by date.
- Filter attendance by class.
- Identify absent students.
- Identify late students if lateness is supported.
- Review attendance timestamps.
- Correct attendance records where authorized.
- Generate attendance reports.

Parents and students should only see attendance information they are authorized to access.

## 20. Notifications

The system should provide a notification mechanism for important school events and actions.

Initial notification requirements include:

- Outstanding fee reminders.
- Payment confirmations.
- Important academic notifications.
- Other administrative notifications as required.

The notification system should be designed so additional notification types can be introduced later.

## 21. Functional Requirements

The system must:

1. Authenticate users securely.
2. Apply role-based access control.
3. Allow parents to manage multiple children under one account.
4. Allow administrators to manage students, classes, subjects, and users.
5. Allow teachers to enter CA and examination scores.
6. Automatically calculate results and grades.
7. Allow authorized users to view academic results.
8. Generate/view report cards.
9. Track Madrassah/Qur'an progress.
10. Manage class and subject timetables.
11. Record bank-transfer payments.
12. Track outstanding fees.
13. Send fee reminders.
14. Record biometric attendance.
15. Provide attendance history and reports.
16. Manage admission enquiries.
17. Maintain appropriate access restrictions between users and student records.

> **Note (drafting inconsistency, flagged during backend planning):** Item 14 says "Record biometric attendance," which contradicts §18/§24/§25/§29, all of which specify QR-only attendance for MVP with biometric explicitly deferred. Resolved as a drafting error — MVP is QR-only. See `docs/BACKEND_PLAN.md` requirements audit.

## 22. Business Rules

- A parent can be associated with multiple students.
- A parent can only access information belonging to their linked children.
- Teachers can only enter scores for classes/subjects assigned to them.
- Madrassah instructors use the same teacher portal.
- Result calculations must be performed automatically by the system.
- Only authorized users can modify or finalize results.
- Attendance must be associated with the correct student and date/time.
- Fee payments recorded through bank transfer must be confirmed by authorized accounts staff.
- Users must not be able to access information outside their assigned permissions.
- September is the primary admission intake period.
- Transport and hostel operations are outside the initial system scope.

## 23. Non-Functional Requirements

**Security**

- Secure authentication.
- Role-based authorization.
- Protection of student and financial information.
- Secure handling of passwords and sessions.
- Auditability of important administrative actions.

**Performance**

- Common portal pages should load quickly.
- Score and attendance submissions should provide immediate feedback.
- The system should support concurrent users during periods of high activity.

**Responsiveness**

The portal should work across:

- Desktop computers.
- Laptops.
- Tablets.
- Mobile phones.

**Scalability**

The architecture should allow additional school-management features to be added without requiring a complete rebuild.

## 24. MVP Scope

The initial MVP should include:

**Administration**

- Authentication.
- User management.
- Role/permission management.
- Student management.
- Class management.
- Subject management.
- Academic session/term management.

**Academics**

- Teacher dashboard.
- CA score entry.
- Examination score entry.
- Automatic result calculation.
- Result checker.
- Report cards.
- Timetable management.

**Madrassah**

- Qur'an memorization tracking.
- Surah tracking.
- Juz' tracking.
- Tajweed progress tracking.

**Finance**

- Fee management.
- Bank-transfer payment recording.
- Payment history.
- Outstanding balance tracking.
- Fee reminders.

**Attendance**

The MVP will include:

- Student-specific QR codes.
- QR code scanning.
- Attendance validation.
- Attendance date/time recording.
- Attendance history.
- Attendance reports.
- Duplicate attendance prevention.
- Authorized attendance correction.
- Attendance status tracking.

**Biometric attendance is not included in the MVP.**

**Admissions**

- Admission enquiry form.
- Enquiry management.
- September intake information.

**Parent Portal**

- Multiple children under one account.
- Results.
- Timetable.
- Attendance.
- Fees/payment information.
- Notifications.

## 25. Out of Scope for MVP

The following features are explicitly deferred:

- Online admission applications.
- Admission document uploads.
- Online entrance examinations.
- Assessment booking.
- Automated admission letters.
- Automated offer letters.
- Computer-Based Testing (CBT).
- E-learning platform.
- Video lessons.
- Assignment submission.
- Online homework.
- Transport management.
- Hostel management.
- Online payment gateway integration.

These features may be considered in future versions.

## 26. Acceptance Criteria

The MVP will be considered functionally complete when:

**User Management**

- Users can securely log in.
- Users see only features appropriate to their roles.
- Administrators can manage users and permissions.

**Students & Parents**

- Students can be created and assigned to classes.
- Parents can be linked to one or more students.
- Parents can switch between their children.

**Academics**

- Teachers can enter CA scores.
- Teachers can enter examination scores.
- The system calculates results automatically.
- Authorized users can view completed results.
- Report cards can be generated/viewed.

**Madrassah**

- Instructors can record Qur'an progress.
- Progress can be viewed by authorized users.

**Timetable**

- Administrators can configure timetables.
- Teachers, students, and parents can view relevant schedules.

**Finance**

- Accounts staff can record bank-transfer payments.
- Outstanding balances are calculated/displayed.
- Parents can view their children's financial status.
- Fee reminders can be triggered automatically.

**Attendance**

- Biometric attendance can identify students.
- Attendance is recorded with date/time.
- Authorized users can view attendance history and reports.

> **Note (drafting inconsistency, flagged during backend planning):** The first Attendance bullet says "Biometric attendance can identify students," which contradicts the QR-only MVP scope defined in §18/§24/§25/§29. Resolved as a drafting error — read as "QR-based attendance can identify students." See `docs/BACKEND_PLAN.md` requirements audit.

**Admissions**

- Prospective parents can submit an enquiry.
- Staff can view and manage enquiries.
- September intake information can be displayed.

## 27. Dependencies

The project depends on:

- QR code generation and scanning implementation.
- Devices capable of scanning student QR codes.
- Reliable network connectivity during attendance sessions.
- Definition of the school's attendance rules.
- Definition of how late arrivals will be handled.
- Confirmation of whether location verification will be required for the MVP.

## 28. Open Questions / Requirements to Confirm

**Attendance**

1. Will each student have a permanent QR code, or will the QR code change periodically?
2. Who will scan the QR code — teacher, attendance officer, or a dedicated scanning device?
3. Can a student's QR code be scanned from another student's phone?
4. Should attendance require the scanning device to be within the school/location?
5. Should GPS/location verification be used alongside QR scanning?
6. How should late attendance be recorded?
7. What happens when a student forgets or loses their QR code?
8. Who is allowed to manually correct attendance?
9. Should parents receive attendance notifications?
10. Should the system automatically mark students absent after the attendance period closes?

> **Resolved during backend planning (see `docs/BACKEND_PLAN.md`):** Q2 — staff-authenticated scanning (teacher/admin device, not a dedicated kiosk) for MVP. Others remain open; documented assumptions used where the answer wasn't blocking for schema design.

## 29. Future Considerations

The QR attendance architecture should be designed so that additional verification methods can be introduced later, including:

- Location/GPS verification.
- Device verification.
- Rotating/dynamic QR codes.
- Biometric attendance.
- NFC/RFID attendance.

These should not be required for the initial MVP.

## 30. Product Direction

The first version should prioritize **reliable core school operations over feature quantity**.

The MVP should establish the portal as the school's central system for:

Students → Academics → Attendance → Fees → Parents → Administration

Future functionality can then be added around this foundation without disrupting the core system.
